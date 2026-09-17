// 批次稽核：對任意數量的地方政府單位預算 PDF 跑解析，輸出「機器可讀的檢驗結果」。
//
//   node audit.mjs <pdf|dir>... [--out report.json] [--jsonl]
//
// 與 test.mjs 的分工：
//   test.mjs  = 回歸測試，五份已知 PDF 的期望值寫死，任何變動都要人來確認
//   audit.mjs = 探索性稽核，對「沒看過的 PDF」跑不變式檢查，用來找新的版面破口
//
// 判定一律由本檔的確定性規則做，不交給人或 agent 目測——目測會漏、會累、會編。
// 檢查分兩級：
//   blocker：違反即為 bug，無需 ground truth 就能斷定（如上下層加總不符、同一計畫兩種預算數）
//   warn   ：品質指標超出區間，可能是資料本身的限制，需人工判讀（如孤兒句比例過高），
//            以及四層驗算看不到的準確度指標：數量×單價≠預算數、金額不在它宣稱的頁面、
//            疑似同一行重複計列、兩個引擎的結果不一致
// 退出碼：有任何 blocker → 1；只有 warn → 0。CI 與 agent 都靠這個判斷。

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

// ── 品質指標的可接受區間。超出不代表壞掉，代表「值得看一眼」 ──
// 上界取自六個機關的實測最差值再放寬，不是憑感覺訂的：
//   孤兒句比例最高為教育部 446/1313 = 34%（其說明按單位而非按科目撰寫，屬資料限制）
const WARN = {
    // 以下兩個準確度指標在七份樣本皆為 0，是目前的水準線；一旦出現代表欄位或頁碼開始跑掉
    qtyPriceViolation: 0,    // 明細列「數量×單價≠預算數」的筆數
    pageProvenanceViolation: 0,  // 明細列金額不在宣稱頁面／疑似同一行重複計列的筆數
    unmatchedRate: 0.10,     // 在機關別預算表找不到對應編號的工作計畫比例（七份實測現為 0）
    detailPerL2: 0.5,        // 明細列 / 二級科目列。低於此代表明細層多半沒讀到
};

// index.html 會用 new URL('cmaps/', location.href) 決定 CMap 來源，而 createObjectURL
// 只有瀏覽器有：用真正的 URL 建構子（瀏覽器兩個都有）補上這兩個靜態方法。
const URL_SHIM = globalThis.URL;
URL_SHIM.createObjectURL = () => '';
URL_SHIM.revokeObjectURL = () => { };

function loadTool(html) {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    const js = scripts.at(-1)[1].replace(/pdfjsLib\.GlobalWorkerOptions\.workerSrc\s*=\s*[^;]+;?/g, '');
    const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', addEventListener() { }, click() { }, setAttribute() { }, getBoundingClientRect: () => ({ height: 30 }) };
    const ctx = {
        console: { log() { }, warn() { }, error() { } },   // 解析過程的雜訊不進報告
        document: { getElementById: () => stub, createElement: () => ({ ...stub }), querySelector: () => null, querySelectorAll: () => [] },
        window: {}, pdfjsLib: { GlobalWorkerOptions: {} },
        location: { protocol: 'http:', href: 'http://127.0.0.1:8963/index.html' },
        URL: URL_SHIM, Blob: function () { },
        setTimeout, clearTimeout, Uint8Array, ArrayBuffer, Map, Set,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    return ctx;
}

// 引擎鏈與 index.html 的 _parse 相同：pdf.js（帶自帶 CMap）先跑，讀不出來、例外或四層驗算
// 對不上時讓 PDFium 複核，取捨用 index.html 的 _engineRank／_isBetterEngine 決定。
// 稽核若自行決定「用哪個引擎」，就會與實際行為漂移——這正是本檔開頭警告的那件事。
const CMAP_DIR = new URL('cmaps/', import.meta.url).pathname;
let _pdfiumLib = null;
async function openPdf(ctx, data) {
    const bytes = new Uint8Array(data);
    const cands = [];
    let pdf = null;
    try {
        pdf = await getDocument({ data: Uint8Array.from(bytes), cMapUrl: CMAP_DIR, cMapPacked: true }).promise;
        cands.push({ engine: 'pdf.js', pdf, rows: await ctx.parseLocalDoc(pdf) });
    } catch (e) {
        if (pdf) { try { await pdf.destroy(); } catch { } }
        cands.push({ engine: 'pdf.js', pdf: null, rows: [], error: String(e && e.message || e) });
    }
    const best = cands[0];
    if (!best.rows.length || ctx._engineRank(best.rows)[0] > 0) {
        if (!_pdfiumLib) { _pdfiumLib = await pdfiumInit(); _pdfiumLib.PDFiumExt_Init(); }
        const fake = ctx._pdfiumFakeDoc(_pdfiumLib, Uint8Array.from(bytes));
        let altRows = [];
        try { altRows = await ctx.parseLocalDoc(fake); } catch { altRows = []; }
        if (altRows.length && ctx._isBetterEngine(altRows, best.rows)) {
            if (best.pdf) { try { await best.pdf.destroy(); } catch { } }
            best.engine = 'PDFium'; best.pdf = fake; best.rows = altRows;
        } else {
            try { fake.destroy(); } catch { }
        }
    }
    best.candidates = cands.map(c => ({ engine: c.engine, rows: c.rows.length, mismatches: c.rows.length ? ctx.reconcile(c.rows).length : null, error: c.error || null }));
    if (!best.pdf) throw Error('兩個引擎都無法開啟這份 PDF');
    return best;
}

const n = v => +String(v ?? '').replace(/,/g, '');

// 四層加總與工作計畫核對一律呼叫工具自己的函式，不在此複寫規則——
// 本專案的教訓是：外部驗證腳本一旦自行複寫解析/驗算邏輯，就會與實際行為漂移而得出失真結論。

// ── blocker：同一個 planCode 不得出現兩種 planBudget ──
// 實測曾因「經常門／資本門分兩段、累加後未回填先前的列」而違反；四層驗算取最後一列故
// 一路通過，匯出的欄位卻自相矛盾。這條專門守住它。
function checkPlanBudgetConsistent(rows) {
    const m = new Map();
    for (const r of rows) {
        if (!r.planCode || !r.planBudget) continue;
        if (!m.has(r.planCode)) m.set(r.planCode, new Set());
        m.get(r.planCode).add(String(r.planBudget));
    }
    return [...m].filter(([, v]) => v.size > 1).map(([code, v]) => ({ planCode: code, values: [...v] }));
}

// ── blocker：欄位形狀 ──
// 名稱欄混進表格內文或說明文字＝抽取越界。這些特徵字不可能出現在合法的計畫/科目名裡。
// 「合計」不可裸用：中央版實測「辦理戶政綜**合計**畫及研習活動」跨詞邊界誤中，那是合法名稱。
const NAME_POISON = /千元|歲出計畫說明|說明合計|合計\d|計畫內容|項目內容|預算數|承辦單位|名稱與編號|業務計畫及工作計畫|如下[：:]/;
function checkFieldShape(rows) {
    const v = [];
    const seen = new Set();
    const add = (kind, detail) => { const k = kind + '|' + detail; if (!seen.has(k)) { seen.add(k); v.push({ kind, detail }); } };
    for (const r of rows) {
        if (r.planCode && !/^(?:\d{10,11}|\d{4}[a-z]\d{6})$/i.test(r.planCode)) add('planCode 格式非法', r.planCode);
        if (r.planCode && !String(r.planName || '').trim()) add('planName 為空', r.planCode);
        if (r.planName && NAME_POISON.test(r.planName)) add('planName 混入表格內文', `${r.planCode} 「${String(r.planName).slice(0, 40)}」`);
        if (r.branchName && NAME_POISON.test(r.branchName)) add('branchName 混入表格內文', `${r.planCode} 「${String(r.branchName).slice(0, 40)}」`);
        if (r.amount !== '' && r.amount != null && !Number.isFinite(n(r.amount))) add('amount 非數值', `${r.planCode} ${r.amount}`);
        if (r.amount !== '' && r.amount != null && n(r.amount) < 0) add('amount 為負', `${r.planCode} ${r.amount}`);
        // 總經費列必須標 excluded，否則會被算進本年度合計（重複計算全期經費）
        if (r.level === '總經費' && r.excluded !== true) add('總經費列未標 excluded', `${r.planCode} ${r.desc || ''}`.slice(0, 60));
    }
    return v;
}

// 數量欄實際寫法有「362×12」（362 人×12 月）這種算式，不能拔掉非數字直接取值。
function evalQty(s) {
    const t = String(s ?? '').replace(/[,\s]/g, '').replace(/[xX*＊✕]/g, '×').replace(/[－ー–—]/g, '-');
    if (!t || !/^[\d.]+(?:[×\-/][\d.]+)*$/.test(t)) return null;
    const parts = t.split(/([×\-/])/);
    let acc = parseFloat(parts[0]);
    if (!Number.isFinite(acc)) return null;
    for (let i = 1; i < parts.length; i += 2) {
        const v = parseFloat(parts[i + 1]);
        if (!Number.isFinite(v)) return null;
        if (parts[i] === '×') acc *= v; else if (parts[i] === '-') acc -= v; else acc /= v;
    }
    return acc;
}

// ── warn：數量 × 單價 = 預算數 ──
// 欄位互證：與表格結構無關，只有數量、單價、預算數三者都被分到正確的欄才會成立；
// 欄位黏連或誤判（例如把單價讀成數量）都會在這裡現形。單價可能是四捨五入後的値
// （實測 1.5×52301 → 78451.5 印成 78452），故容許四捨五入到整數元。
function checkQtyPrice(rows) {
    const v = [];
    for (const r of rows) {
        if (r.level !== '明細' || !r.qty || !r.price || r.amount === '') continue;
        const q = evalQty(r.qty), p = n(r.price), a = n(r.amount);
        if (q == null || !Number.isFinite(p) || !Number.isFinite(a)) continue;
        if (Math.round(q * p) !== Math.round(a)) {
            v.push({ kind: '數量×單價≠預算數', detail: `${r.planCode}/${r.branchCode}/${r.l2Code || r.l1Code} 第 ${r.page} 頁：${r.qty} × ${r.price} = ${+(q * p).toFixed(2)}，表列 ${r.amount}` });
        }
    }
    return v;
}

// ── warn：金額是否真的印在它宣稱的那一頁 ──
// 頁碼是使用者回查原文的依據；這條用另一個方向的抽取（整頁文字）反證列的出處。
// 只驗明細列（金額以元為單位印出）；計畫說明列印的是「千元」故不適用。
// 重複列另外驗：同一組 (計畫, 科目, 金額, 頁) 出現兩次時，該頁文字必須也出現兩次，
// 否則就是同一行被讀了兩次（四層驗算若剛好被別的誤讀抵銷就會一路通過）。
async function checkPageProvenance(pdf, rows) {
    const pages = [...new Set(rows.filter(r => r.level === '明細' && r.page).map(r => r.page))];
    const text = new Map();
    for (const p of pages) {
        try {
            const pg = await pdf.getPage(p);
            const tc = await pg.getTextContent();
            text.set(p, tc.items.map(i => i.str).join('').replace(/[\s,，]/g, ''));
        } catch { text.set(p, null); }
    }
    const v = [];
    const seen = new Map();
    for (const r of rows) {
        if (r.level !== '明細' || !r.page) continue;
        const t = text.get(r.page);
        if (t == null) continue;
        const amt = String(r.originalAmount ?? r.amount).replace(/[\s,，]/g, '');
        if (!amt) continue;                       // 沒有金額的明細列（純說明列）不適用這條
        const hits = t.split(amt).length - 1;
        if (!hits) {
            v.push({ kind: '金額不在宣稱的頁面', detail: `${r.planCode}/${r.branchCode}/${r.l2Code || r.l1Code} 第 ${r.page} 頁找不到 ${r.amount}「${String(r.desc || '').slice(0, 20)}」` });
        }
        const key = [r.planCode, r.branchCode, r.l2Code || r.l1Code, amt, r.page].join('|');
        if (seen.has(key)) {
            if (hits < 2) {
                v.push({ kind: '疑似同一行重複計列', detail: `第 ${r.page} 頁 ${amt} 只出現 ${hits} 次，卻有兩列明細` });
            }
        } else {
            seen.set(key, 1);
        }
    }
    return v;
}

async function auditOne(html, file, toolVersion) {
    const t0 = Date.now();
    const rec = { file, tool: 'local-budget-parser', toolVersion, ok: false, blockers: [], warnings: [] };
    let pdf = null;
    try {
        const ctx = loadTool(html);
        const data = await readFile(file);
        const opened = await openPdf(ctx, data);
        pdf = opened.pdf;
        const rows = opened.rows;
        rec.engine = opened.engine;
        rec.pages = pdf.numPages;
        rec.agency = ctx.detectedAgency() || null;

        if (!rows.length) {
            rec.blockers.push({ check: 'parse', detail: '兩種引擎都解析不出資料列（可能不是地方單位預算，或版面未支援）' });
            return rec;
        }
        const by = lv => rows.filter(r => r.level === lv).length;
        rec.counts = {
            rows: rows.length,
            plans: new Set(rows.map(r => r.planCode).filter(Boolean)).size,
            branches: by('分支計畫'), l1: by('用途別一級'), l2: by('用途別二級'),
            detail: by('明細'), cases: by('案別'), totalCost: by('總經費'),
            repairs: (ctx.getRepairs ? ctx.getRepairs().length : null),
        };

        const four = ctx.reconcile(rows);
        if (four.length) rec.blockers.push({ check: 'fourLayer', count: four.length, sample: four.slice(0, 5) });

        const pb = checkPlanBudgetConsistent(rows);
        if (pb.length) rec.blockers.push({ check: 'planBudgetConsistent', count: pb.length, sample: pb.slice(0, 5) });

        const shape = checkFieldShape(rows);
        if (shape.length) rec.blockers.push({ check: 'fieldShape', count: shape.length, sample: shape.slice(0, 8) });

        // 準確度指標：欄位互證與頁碼出處。這兩項不影響「加總對不對」，但會抓到
        // 「數字算得平、欄位卻是錯的」與「頁碼指錯頁」這種四層驗算看不到的錯。
        const qp = checkQtyPrice(rows);
        rec.accuracy = { qtyPriceChecked: rows.filter(r => r.level === '明細' && r.qty && r.price).length, qtyPriceViolations: qp.length };
        if (qp.length) rec.warnings.push({ check: 'qtyPrice', count: qp.length, sample: qp.slice(0, 5), detail: '數量×單價與預算數不符（可能是欄位誤判，或原表單價為四捨五入値）' });

        const prov = await checkPageProvenance(pdf, rows);
        rec.accuracy.pageProvenanceViolations = prov.length;
        if (prov.length) rec.warnings.push({ check: 'pageProvenance', count: prov.length, sample: prov.slice(0, 5), detail: '金額不在它宣稱的頁面／疑似同一行重複計列' });

        // 兩個引擎都讀得出東西時，記下它們是否一致（差異本身就是要看的訊號）
        const cands = (opened.candidates || []).filter(c => c.rows);
        if (cands.length > 1) {
            const same = cands.every(c => c.rows === cands[0].rows && c.mismatches === cands[0].mismatches);
            rec.engineAgreement = { same, candidates: cands };
            if (!same) rec.warnings.push({ check: 'engineAgreement', detail: '兩個引擎的列數或驗算結果不同：' + JSON.stringify(cands), sample: cands });
        }

        const ag = await ctx.parseAgencyPlanTable(pdf);
        rec.counts.agencyTablePages = ag.pages;
        if (!ag.pages) {
            rec.warnings.push({ check: 'crossCheck', detail: '這份 PDF 沒有歲出機關別預算表，工作計畫的編號與金額無外部依據' });
            rec.crossCheck = { available: false };
        } else {
            const c = ctx.crossCheckAgencyPlans(rows, ag);
            rec.crossCheck = { available: true, checked: c.checked, total: c.total, unmatched: c.unmatched.length };
            if (c.issues.length) rec.blockers.push({ check: 'crossCheck', count: c.issues.length, sample: c.issues.slice(0, 8) });
            if (c.unmatched.length) {
                const rate = c.total ? c.unmatched.length / c.total : 0;
                rec.warnings.push({ check: 'crossCheckUnmatched', count: c.unmatched.length, rate: +rate.toFixed(3), sample: c.unmatched.slice(0, 8), detail: '這些計畫在機關別預算表找不到對應編號，金額未經外部核對' });
            }
            if (c.budgetUnverified.length) rec.warnings.push({ check: 'agencyAmountUnextracted', count: c.budgetUnverified.length, sample: c.budgetUnverified.slice(0, 5) });
            if (c.nameUnverified.length) rec.warnings.push({ check: 'agencyNameUnextracted', count: c.nameUnverified.length, sample: c.nameUnverified.slice(0, 5) });
        }

        const detailPerL2 = rec.counts.l2 ? rec.counts.detail / rec.counts.l2 : 0;
        rec.quality = { detailPerL2: +detailPerL2.toFixed(2) };
        if (rec.counts.l2 && detailPerL2 < WARN.detailPerL2) rec.warnings.push({ check: 'detailPerL2', value: +detailPerL2.toFixed(2), threshold: WARN.detailPerL2, detail: '明細列偏少，可能整層沒讀到' });

        rec.ok = rec.blockers.length === 0;
    } catch (e) {
        rec.blockers.push({ check: 'exception', detail: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
    } finally {
        try { if (pdf && pdf.destroy) await pdf.destroy(); } catch { }
        rec.durationMs = Date.now() - t0;
    }
    return rec;
}

async function expand(paths) {
    const out = [];
    for (const p of paths) {
        if (statSync(p).isDirectory()) {
            for (const f of await readdir(p)) if (/\.pdf$/i.test(f)) out.push(join(p, f));
        } else if (/\.pdf$/i.test(p)) out.push(p);
    }
    return out.sort();
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const jsonl = args.includes('--jsonl');
const inputs = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
if (!inputs.length) {
    console.error('用法：node audit.mjs <pdf|dir>... [--out report.json] [--jsonl]');
    process.exit(2);
}

let toolVersion = 'unknown';
try { toolVersion = execSync('git rev-parse --short HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(); } catch { }

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const files = await expand(inputs);
const records = [];
for (const f of files) {
    const rec = await auditOne(html, f, toolVersion);
    records.push(rec);
    if (jsonl) console.log(JSON.stringify(rec));
    const tag = rec.blockers.length ? `✗ blocker ${rec.blockers.length}` : rec.warnings.length ? `△ warn ${rec.warnings.length}` : '✓';
    console.error(`${tag}  ${basename(f)}｜${rec.agency || '機關未偵測'}｜${rec.engine || '-'}｜${rec.counts ? `${rec.counts.plans} 計畫／${rec.counts.rows} 列` : '無資料列'}`);
    for (const b of rec.blockers) console.error(`      blocker ${b.check}${b.count ? ` ×${b.count}` : ''}${b.detail ? '：' + b.detail : ''}`);
}

const summary = {
    generatedAt: new Date().toISOString(),
    tool: 'local-budget-parser',
    toolVersion,
    total: records.length,
    passed: records.filter(r => r.ok && !r.warnings.length).length,
    warned: records.filter(r => r.ok && r.warnings.length).length,
    failed: records.filter(r => !r.ok).length,
    blockerByCheck: records.flatMap(r => r.blockers).reduce((m, b) => (m[b.check] = (m[b.check] || 0) + 1, m), {}),
    warnByCheck: records.flatMap(r => r.warnings).reduce((m, b) => (m[b.check] = (m[b.check] || 0) + 1, m), {}),
};
const report = { summary, records };
if (outFile) await writeFile(outFile, JSON.stringify(report, null, 2));
else if (!jsonl) console.log(JSON.stringify(report, null, 2));

console.error(`\n合計 ${summary.total}：通過 ${summary.passed}、僅警告 ${summary.warned}、有 blocker ${summary.failed}`);
console.error('blocker 分布：' + (Object.keys(summary.blockerByCheck).length ? JSON.stringify(summary.blockerByCheck) : '無'));
process.exit(summary.failed ? 1 : 0);
