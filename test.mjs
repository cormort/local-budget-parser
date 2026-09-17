// 回歸測試：用真實 PDF 驗證解析結果沒有退化。
// 直接載入 index.html 內的解析核心（parseLocalDoc / reconcile），不自行複寫規則。

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import vm from 'node:vm';

const EXPECT = {
    '臺北市': {
        file: 'examples/taipei-116.pdf',
        engine: 'pdf.js',
        agency: '臺北市政府主計處',
        plans: 4,
        branches: 14,
        l1: 20,
        l2: 53,
        detail: 97,
        rows: 192,
        agencyTable: { pages: 2, checked: 4, issues: 0, unmatched: 0 },
    },
    '臺中市': {
        file: 'examples/taichung-115.pdf',
        engine: 'pdf.js',
        agency: '臺中市政府主計處',
        plans: 7,
        branches: 5,
        l1: 22,
        l2: 89,
        detail: 144,
        rows: 267,
        agencyTable: { pages: 2, checked: 7, issues: 0, unmatched: 0 },
    },
    // 以下三份的內文字型是 2-byte CID（Adobe-CNS1／ETen-B5…）：沒有 CMap 時 pdf.js
    // 會整份讀不出來（0 列）而退回 PDFium。自帶 cmaps/ 之後 pdf.js 讀得完，且結果與
    // PDFium 一致或更好，因此預期引擎改為 pdf.js；PDFium 後備路徑另見 FALLBACK_CASE。
    '高雄市': {
        file: 'examples/kaohsiung-115.pdf',
        engine: 'pdf.js',
        agency: '高雄市政府主計處',
        plans: 4,
        branches: 8,
        l1: 19,
        l2: 73,
        detail: 116,
        rows: 220,
        agencyTable: { pages: 1, checked: 4, issues: 0, unmatched: 0 },
    },
    '新北市': {
        file: 'examples/newtaipei-115.pdf',
        engine: 'pdf.js',
        agency: '新北市政府主計處',
        plans: 11,
        branches: 6,
        l1: 21,
        l2: 50,
        detail: 89,
        // pdf.js + CMap 讀到 180 列：比 PDFium 多 3 列「計畫說明」（8970a010401 經常／資本門
        // 與 7670a030201），三列的金額都與來源頁面及機關別預算表核對相符，是 PDFium 漏讀。
        rows: 180,
        agencyTable: { pages: 4, checked: 11, issues: 0, unmatched: 0 },
    },
    // 主管單位預算（社會局＋所屬 5 機關，341 頁）。說明欄有大量公文字號，是
    //「工作計畫代碼只能取自表頭帶」這條規則的實證：放寬到整頁搜尋時，
    // 1140761123A 等公文字號會變成假計畫，其後數十頁明細全部改掛到假計畫下。
    // 案號與案名之間沒有破折號的寫法（「03115年度道路工程規劃設計」），
    // 是「案別不能只認破折號」這條規則的實證：只認破折號時案小計會被算進上一個科目。
    '臺北市新工處': {
        file: 'examples/taipei-newworks-116.pdf',
        engine: 'pdf.js',
        agency: '臺北市政府工務局新建工程處',
        plans: 4,
        branches: 17,
        l1: 58,
        l2: 133,
        detail: 265,
        rows: 579,
        agencyTable: { pages: 4, checked: 4, issues: 0, unmatched: 0 },
        extra(rows, errors) {
            addMismatch(errors, '案別列數', 41, rows.filter(r => r.level === '案別').length);
        },
    },
    '新北市政府社會局': {
        file: 'examples/newtaipei-social-115.pdf',
        engine: 'pdf.js',
        agency: '新北市政府社會局',
        plans: 15,
        branches: 37,
        l1: 68,
        l2: 269,
        detail: 1161,
        rows: 1555,
        agencyTable: { pages: 10, checked: 15, issues: 0, unmatched: 0 },
        extra(rows, errors) {
            const sum = rs => rs.reduce((t, r) => t + (+r.amount || 0), 0);
            for (const code of ['1140761123A', '1130401415H', '1140012435D']) {
                if (rows.some(r => r.planCode === code)) {
                    errors.push(`公文字號誤判為工作計畫：${code}`);
                }
            }
            const own = ['61111100301', '62111100101', '62111100201',
                '63111100201', '63111109801', '72111100201'];
            for (const code of own) {
                if (!rows.some(r => r.planCode === code)) {
                    errors.push(`缺少工作計畫：${code}`);
                }
            }
            // 1020 的明細橫跨第 93 頁以後的續頁，是「續頁只承接、不新建計畫」的實證
            addMismatch(errors, '1020 約聘僱人員待遇明細合計', 258_082_464,
                sum(rows.filter(r => r.level === '明細' && r.planCode === '62111100101'
                    && r.branchCode === '01' && r.l2Code === '1020')));
            // 預算書提要：主管歲出總額 = 各計畫預算金額之和；社會局本身為前 6 個計畫
            const pb = new Map(rows.filter(r => r.planBudget).map(r => [r.planCode, +r.planBudget]));
            addMismatch(errors, '主管歲出總額', 32_512_125_000,
                [...pb.values()].reduce((a, b) => a + b, 0));
            addMismatch(errors, '社會局歲出總額', 29_414_144_000,
                own.reduce((a, c) => a + (pb.get(c) || 0), 0));
        },
    },
};

// 社會局案例若已放入 examples/，自動加入回歸測試。
// 尚未加入檔案時不會讓既有測試失敗，但會顯示略過提示。
const SOCIAL_CASE = {
    name: '臺北市政府社會局',
    file: 'examples/taipei-social-116.pdf',
    agency: '臺北市政府社會局',
    agencyTable: { pages: 5, checked: 7, issues: 0, unmatched: 0 },
    engine: 'pdf.js',
};

// index.html 會用 new URL('cmaps/', location.href) 決定 CMap 來源，而 createObjectURL
// 只有瀏覽器有：用真正的 URL 建構子（瀏覽器兩個都有）補上這兩個靜態方法。
const URL_SHIM = globalThis.URL;
URL_SHIM.createObjectURL = () => '';
URL_SHIM.revokeObjectURL = () => { };

let _pdfiumLib = null;

// 地方政府預算書的內文字型大量使用 2-byte CID（Adobe-CNS1／ETen-B5…）。pdf.js 沒有
// CMap 字元對應表時，整份文件的字元流解不出來（實測高雄市、新北市、新北市社會局
// 會變成 0 列，只能退回 PDFium）。這裡指到 repo 內自帶的同源 cmaps/。
const CMAP_DIR = new URL('cmaps/', import.meta.url).pathname;
// 測試替身模擬的部署位置，用來驗 _CMAP_URL 算出來是不是同源 cmaps/。
const SITE_URL = 'http://127.0.0.1:8963/index.html';

function extractInlineScript(html) {
    // 排除 <script src="...">，只取實際包含解析核心的內嵌 script。
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    if (!scripts.length) throw new Error('index.html 找不到內嵌 JavaScript');
    return scripts.at(-1)[1]
        .replace(/pdfjsLib\.GlobalWorkerOptions\.workerSrc\s*=\s*[^;]+;?/g, '');
}

function loadTool(html) {
    const js = extractInlineScript(html);

    const stub = {
        files: { length: 0 },
        style: {},
        value: '',
        textContent: '',
        innerHTML: '',
        addEventListener() {},
        click() {},
        setAttribute() {},
        getBoundingClientRect() { return { height: 30 }; },
    };

    const ctx = {
        console,
        document: {
            getElementById: () => stub,
            createElement: () => ({ ...stub }),
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        window: {},
        pdfjsLib: { GlobalWorkerOptions: {} },
        location: { protocol: 'http:', href: SITE_URL },
        URL: URL_SHIM,
        Blob: function Blob() {},
        setTimeout,
        clearTimeout,
        Uint8Array,
        ArrayBuffer,
        Map,
        Set,
    };

    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(js, ctx, { filename: 'index.html:inline-script' });
    return ctx;
}

function countByLevel(rows, level) {
    return rows.filter(r => r.level === level).length;
}

function issueText(issue) {
    if (typeof issue === 'string') return issue;
    return [
        issue.type,
        issue.plan,
        issue.branch,
        `${issue.code || ''} ${issue.name || ''}`.trim(),
        `表列 ${issue.listed ?? ''}`,
        `加總 ${issue.sum ?? ''}`,
        `差異 ${issue.diff ?? ''}`,
        issue.page ? `PDF 第 ${issue.page} 頁` : '',
    ].filter(Boolean).join('｜');
}

function findDetail(rows, branchName, code, descriptionText) {
    return rows.find(r =>
        r.level === '明細'
        && r.branchName === branchName
        && (r.l2Code || r.l1Code) === code
        && (r.desc || '').includes(descriptionText)
    );
}

function addMismatch(errors, label, expected, actual) {
    if (actual !== expected) {
        errors.push(`${label}: 期望 ${expected}，實際 ${actual}`);
    }
}

async function fileExists(relativePath) {
    try {
        await access(new URL(relativePath, import.meta.url));
        return true;
    } catch {
        return false;
    }
}

async function openPdf(ctx, data, engine) {
    if (engine === 'pdfium') {
        if (!_pdfiumLib) {
            _pdfiumLib = await pdfiumInit();
            _pdfiumLib.PDFiumExt_Init();
        }
        return ctx._pdfiumFakeDoc(_pdfiumLib, data);
    }
    return getDocument({ data, cMapUrl: CMAP_DIR, cMapPacked: true }).promise;
}

// 與 index.html 的 _parse 同一條引擎鏈：pdf.js（帶 CMap）先跑，讀不出來、讀到一半例外
// 或四層驗算對不上時，才讓 PDFium 複核，並用 index.html 的 _isBetterEngine 決定留誰。
// 評分規則不在此複寫，否則驗證腳本會與實際行為漂移。
async function parseBest(ctx, data, prefer = 'pdf.js') {
    const out = { engine: 'pdf.js', rows: [], error: null };
    if (prefer === 'pdf.js') {
        const pdf = await openPdf(ctx, data, 'pdf.js');
        try {
            out.rows = await ctx.parseLocalDoc(pdf);
        } catch (e) {
            out.error = e;
            out.rows = [];
        } finally {
            if (pdf?.destroy) await pdf.destroy();
        }
        if (out.rows.length && !ctx.reconcile(out.rows).length) return out;
    }
    const fake = await openPdf(ctx, data, 'pdfium');
    let alt = [];
    try {
        alt = await ctx.parseLocalDoc(fake);
    } finally {
        if (fake?.destroy) fake.destroy();
    }
    if (alt.length && (prefer === 'pdfium' || !out.rows.length || ctx._isBetterEngine(alt, out.rows))) {
        out.rows = alt;
        out.engine = 'pdfium';
    }
    if (!out.rows.length && out.error) throw out.error;
    return out;
}

async function runBaselineCase(name, want, html) {
    const ctx = loadTool(html);
    const data = new Uint8Array(await readFile(new URL(want.file, import.meta.url)));
    const used = await parseBest(ctx, data, want.prefer || 'pdf.js');

    let rows = used.rows, agencyCheck = null, agencyPages = 0;
    {
        // 工作計畫核對：拿同一本預算書的「歲出機關別預算表」當外部基準，驗工作計畫的
        // 編號、名稱與本年度預算數。四層加總驗算只證明本表自己前後一致（頂端的工作計畫
        // 預算數就取自本表自身），這條才驗得到那個頂端數字。
        const pdf = await openPdf(ctx, data, used.engine);
        try {
            const ag = await ctx.parseAgencyPlanTable(pdf);
            agencyPages = ag.pages;
            if (ag.pages) agencyCheck = ctx.crossCheckAgencyPlans(rows, ag);
        } finally {
            if (pdf?.destroy) await pdf.destroy();
        }
    }

    const got = {
        agency: ctx.detectedAgency(),
        plans: new Set(rows.map(r => r.planCode)).size,
        branches: countByLevel(rows, '分支計畫'),
        l1: countByLevel(rows, '用途別一級'),
        l2: countByLevel(rows, '用途別二級'),
        detail: countByLevel(rows, '明細'),
        rows: rows.length,
    };

    const errors = [];
    for (const [key, expected] of Object.entries(want)) {
        if (key === 'file' || key === 'engine' || key === 'prefer' || key === 'extra' || key === 'agencyTable') continue;
        addMismatch(errors, key, expected, got[key]);
    }
    // 引擎選擇本身也是行為：Big5 內文字型的文件現在應該由 pdf.js（帶 CMap）讀完，
    // 而不是像以前一樣整份丟給較弱的 PDFium。
    if (want.engine) addMismatch(errors, '實際使用的引擎', want.engine, used.engine);

    // 工作計畫核對的期望值刻意記「目前實際數」而非 0：11 筆不符是真實存在的問題
    // （6 筆概況表 planName 被截斷、5 筆本年度預算數與機關別表對不上，後者需翻 PDF 判斷
    // 哪一側正確）。釘住數字是為了讓「修好了」或「又壞了」都會在這裡顯示出來。
    if (want.agencyTable) {
        const w = want.agencyTable;
        addMismatch(errors, '機關別預算表頁數', w.pages, agencyPages);
        addMismatch(errors, '已核對工作計畫數', w.checked, agencyCheck ? agencyCheck.checked : 0);
        addMismatch(errors, '工作計畫核對不符數', w.issues, agencyCheck ? agencyCheck.issues.length : 0);
        addMismatch(errors, '無法核對的工作計畫數', w.unmatched, agencyCheck ? agencyCheck.unmatched.length : 0);
    }
    if (want.extra) want.extra(rows, errors);

    // 新版共同規則：總經費列若存在，必須全部標示 excluded=true。
    const totalCostRows = rows.filter(r => r.level === '總經費');
    const activeTotalCostRows = totalCostRows.filter(r => r.excluded !== true);
    if (activeTotalCostRows.length) {
        errors.push(`總經費排除旗標錯誤：${activeTotalCostRows.length} 列未標示 excluded=true`);
    }

    // 「總工程費／總經費」不得仍被歸類為一般明細。
    // 單位／數量／單價齊全的列是真明細，說明裡寫「總經費明細如下：」只是列出自己的內訳
    //（實測新工處 2018「…總經費明細如下：1.…2,070,000元。2.…30,000元。」內訳合計正好
    // 等於該列的 2,100,000），不是總工程費表頭列。
    const leakedTotalCostDetails = rows.filter(r =>
        r.level === '明細'
        && !r.unit && !r.qty && !r.price
        && /(總工程費|總經費)(?:明細)?如下/.test((r.desc || '').replace(/[\s　]/g, ''))
    );
    if (leakedTotalCostDetails.length) {
        errors.push(`總經費誤入一般明細：${leakedTotalCostDetails.length} 列`);
    }

    const issues = ctx.reconcile(rows);
    errors.push(...issues.map(issue => '驗算不符 → ' + issueText(issue)));

    return { errors, got, rows, ctx, totalCostRows, agencyCheck };
}

async function runSocialCase(html) {
    const ctx = loadTool(html);
    const data = new Uint8Array(await readFile(new URL(SOCIAL_CASE.file, import.meta.url)));
    const used = await parseBest(ctx, data);

    let rows = used.rows, agencyCheck = null, agencyPages = 0;
    {
        // 工作計畫核對：拿同一本預算書的「歲出機關別預算表」當外部基準，驗工作計畫的
        // 編號、名稱與本年度預算數。四層加總驗算只證明本表自己前後一致（頂端的工作計畫
        // 預算數就取自本表自身），這條才驗得到那個頂端數字。
        const pdf = await openPdf(ctx, data, used.engine);
        try {
            const ag = await ctx.parseAgencyPlanTable(pdf);
            agencyPages = ag.pages;
            if (ag.pages) agencyCheck = ctx.crossCheckAgencyPlans(rows, ag);
        } finally {
            if (pdf?.destroy) await pdf.destroy();
        }
    }

    const errors = [];
    addMismatch(errors, 'agency', SOCIAL_CASE.agency, ctx.detectedAgency());
    addMismatch(errors, '機關別預算表頁數', SOCIAL_CASE.agencyTable.pages, agencyPages);
    addMismatch(errors, '已核對工作計畫數', SOCIAL_CASE.agencyTable.checked, agencyCheck ? agencyCheck.checked : 0);
    addMismatch(errors, '工作計畫核對不符數', SOCIAL_CASE.agencyTable.issues, agencyCheck ? agencyCheck.issues.length : 0);
    addMismatch(errors, '無法核對的工作計畫數', SOCIAL_CASE.agencyTable.unmatched, agencyCheck ? agencyCheck.unmatched.length : 0);

    const totalCostRows = rows.filter(r => r.level === '總經費');
    if (!totalCostRows.length) {
        errors.push('未偵測到任何「總經費」層級，可能未套用新版排除規則');
    }
    if (totalCostRows.some(r => r.excluded !== true)) {
        errors.push('部分「總經費」列未標示 excluded=true');
    }

    const leakedTotalCostDetails = rows.filter(r =>
        r.level === '明細'
        && /(總工程費|總經費)(?:明細)?如下/.test((r.desc || '').replace(/[\s　]/g, ''))
    );
    if (leakedTotalCostDetails.length) {
        errors.push(`總工程費／總經費仍誤入一般明細：${leakedTotalCostDetails.length} 列`);
    }

    const checks = [
        {
            label: '116年度聽語障溝通服務方案',
            branch: '身心障礙福利',
            code: '2039',
            text: '116年度辦理臺北市聽語障溝通服務方案',
            amount: 5_921_000,
        },
        {
            label: '116年度身心障礙者專車補助',
            branch: '身心障礙福利',
            code: '4090',
            text: '116年度身心障礙者專車補助',
            amount: 296_000_000,
        },
        {
            label: '敬老愛心卡換發作業相關費用',
            branch: '老人福利',
            code: '2054',
            text: '敬老愛心卡換發作業相關費用',
            amount: 182_100_000,
        },
    ];

    for (const check of checks) {
        const row = findDetail(rows, check.branch, check.code, check.text);
        if (!row) {
            errors.push(`${check.label}: 找不到本年度明細`);
        } else {
            addMismatch(errors, `${check.label}預算數`, check.amount, +row.amount);
        }
    }

    // 驗證指定全期總經費確實保留為「總經費」，且不屬於一般明細。
    const expectedTotalCosts = [47_374_000, 351_000_000, 273_150_000];
    for (const amount of expectedTotalCosts) {
        const found = totalCostRows.some(r => +r.amount === amount);
        if (!found) errors.push(`找不到總經費層級金額 ${amount.toLocaleString('en-US')}`);
    }

    // 驗證「本年度預算數＋2位數案號」不再黏連成巨額假數字。
    // PDF 原文：9,330,000  01-南港社福中心中繼辦公室整修工程
    const southPortCase = rows.find(r =>
        r.level === '案別'
        && r.branchName === '其他修建工程'
        && (r.desc || '').includes('01-南港社福中心中繼辦公室整修工程')
    );
    if (!southPortCase) {
        errors.push('找不到01-南港社福中心中繼辦公室整修工程案別');
    } else {
        addMismatch(
            errors,
            '南港社福中心中繼辦公室整修工程本年度預算',
            9_330_000,
            +southPortCase.amount,
        );
    }

    // PDF 原文：7,808,000  02-民生社區中心中央空調設備汰換暨新設能源管理系統工程分攤款
    const minshengCase = rows.find(r =>
        r.level === '案別'
        && r.branchName === '其他修建工程'
        && (r.desc || '').includes('02-民生社區中心中央空調設備汰換暨新設能源管理系統工程分攤款')
    );
    if (!minshengCase) {
        errors.push('找不到02-民生社區中心中央空調設備案別');
    } else {
        addMismatch(
            errors,
            '民生社區中心中央空調設備本年度預算',
            7_808_000,
            +minshengCase.amount,
        );
    }

    // 直接禁止兩個已知的錯誤重建值再次出現。
    const gluedCaseAmounts = rows.filter(r =>
        +r.amount === 933_000_001
        || +r.amount === 780_800_002
    );
    if (gluedCaseAmounts.length) {
        errors.push(`仍存在金額與案號黏連：${gluedCaseAmounts.length}筆`);
    }

    // 除了四層驗算，再檢查機關本年度最底層明細總額。
    // 此項可防止父子層同時誤判但彼此仍平衡，導致四層驗算假性通過。
    const detailTotal = rows
        .filter(r => r.level === '明細' && !r.excluded)
        .reduce((sum, r) => sum + (+r.amount || 0), 0);
    addMismatch(
        errors,
        '臺北市政府社會局本年度歲出明細總額',
        23_425_696_000,
        detailTotal,
    );

    // 取得 index.html 內部的自動修復紀錄；頂層 let 不會直接成為 ctx 屬性。
    const repairs = vm.runInContext('_repairs', ctx);
    for (const repair of repairs) {
        if (+repair.old === +repair.new) {
            errors.push(`無效自動修復：原始值與修復值相同（${repair.old}）`);
        }
        if (!Number.isFinite(+repair.new)) {
            errors.push(`無效自動修復：修復值不是有限數字（${repair.new}）`);
        }
    }

    const issues = ctx.reconcile(rows);
    errors.push(...issues.map(issue => '驗算不符 → ' + issueText(issue)));

    return {
        errors,
        rows,
        repairs,
        totalCostRows,
        agencyCheck,
        got: {
            agency: ctx.detectedAgency(),
            plans: new Set(rows.map(r => r.planCode)).size,
            branches: countByLevel(rows, '分支計畫'),
            l1: countByLevel(rows, '用途別一級'),
            l2: countByLevel(rows, '用途別二級'),
            detail: countByLevel(rows, '明細'),
            totalCost: totalCostRows.length,
            rows: rows.length,
        },
    };
}

// PDFium 後備路徑的獨立回歸：CMap 或 CDN 被擋掉時，工具會（也必須）退回 PDFium。
// 這條不經過引擎評分，強制走 PDFium，確認後備引擎仍然讀得完、算得平。
async function runFallbackCase(html) {
    const ctx = loadTool(html);
    const data = new Uint8Array(await readFile(new URL('examples/kaohsiung-115.pdf', import.meta.url)));
    const used = await parseBest(ctx, data, 'pdfium');
    const errors = [];
    addMismatch(errors, '後備引擎', 'pdfium', used.engine);
    addMismatch(errors, '後備引擎列數', 220, used.rows.length);
    errors.push(...ctx.reconcile(used.rows).map(i => '後備引擎驗算不符 → ' + issueText(i)));
    const pdf = await openPdf(ctx, data, 'pdfium');
    try {
        const ag = await ctx.parseAgencyPlanTable(pdf);
        const cc = ag.pages ? ctx.crossCheckAgencyPlans(used.rows, ag) : null;
        addMismatch(errors, '後備引擎機關別表頁數', 1, ag.pages);
        addMismatch(errors, '後備引擎工作計畫核對數', 4, cc ? cc.checked : 0);
        addMismatch(errors, '後備引擎工作計畫不符數', 0, cc ? cc.issues.length : -1);
    } finally {
        if (pdf?.destroy) await pdf.destroy();
    }
    return { errors, rows: used.rows.length };
}

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
let failed = 0;

for (const [name, want] of Object.entries(EXPECT)) {
    try {
        const { errors, got, totalCostRows, agencyCheck } = await runBaselineCase(name, want, html);
        if (errors.length) {
            failed++;
            console.error(`✗ ${name}`);
            errors.slice(0, 20).forEach(error => console.error('    ' + error));
            console.error(
                `    （實際：${got.plans}計畫／${got.branches}分支／${got.l1}一級／`
                + `${got.l2}二級／${got.detail}明細／${totalCostRows.length}總經費／共${got.rows}列）`,
            );
        } else {
            console.log(
                `✓ ${name}  ${got.agency}｜${got.plans}計畫／${got.branches}分支／`
                + `${got.l1}一級／${got.l2}二級／${got.detail}明細／`
                + `${totalCostRows.length}總經費｜共${got.rows}列｜四層驗算0不符｜工作計畫核對 ${agencyCheck ? `${agencyCheck.checked}/${agencyCheck.total}，不符 ${agencyCheck.issues.length}${agencyCheck.unmatched.length ? `，無法核對 ${agencyCheck.unmatched.length}` : ''}` : '無機關別表'}`,
            );
        }
    } catch (error) {
        failed++;
        console.error(`✗ ${name}`);
        console.error('    測試執行失敗：' + (error?.stack || error));
    }
}

try {
    const { errors, rows } = await runFallbackCase(html);
    if (errors.length) {
        failed++;
        console.error('✗ PDFium 後備路徑（高雄市）');
        errors.slice(0, 10).forEach(error => console.error('    ' + error));
    } else {
        console.log(`✓ PDFium 後備路徑（高雄市）  強制走 PDFium 仍得 ${rows} 列｜四層驗算0不符｜工作計畫核對 4/4`);
    }
} catch (error) {
    failed++;
    console.error('✗ PDFium 後備路徑（高雄市）');
    console.error('    測試執行失敗：' + (error?.stack || error));
}

if (await fileExists(SOCIAL_CASE.file)) {
    try {
        const { errors, got, repairs, agencyCheck } = await runSocialCase(html);
        if (errors.length) {
            failed++;
            console.error(`✗ ${SOCIAL_CASE.name}`);
            errors.slice(0, 30).forEach(error => console.error('    ' + error));
            console.error(
                `    （實際：${got.plans}計畫／${got.branches}分支／${got.l1}一級／`
                + `${got.l2}二級／${got.detail}明細／${got.totalCost}總經費／`
                + `${repairs.length}自動修復／共${got.rows}列）`,
            );
        } else {
            console.log(
                `✓ ${SOCIAL_CASE.name}  ${got.agency}｜${got.plans}計畫／${got.branches}分支／`
                + `${got.l1}一級／${got.l2}二級／${got.detail}明細／`
                + `${got.totalCost}總經費／${repairs.length}自動修復｜`
                + `共${got.rows}列｜四層驗算0不符｜工作計畫核對 ${agencyCheck ? `${agencyCheck.checked}/${agencyCheck.total}，不符 ${agencyCheck.issues.length}${agencyCheck.unmatched.length ? `，無法核對 ${agencyCheck.unmatched.length}` : ''}` : '無機關別表'}`,
            );
        }
    } catch (error) {
        failed++;
        console.error(`✗ ${SOCIAL_CASE.name}`);
        console.error('    測試執行失敗：' + (error?.stack || error));
    }
} else {
    console.warn(`△ 略過${SOCIAL_CASE.name}：尚未找到 ${SOCIAL_CASE.file}`);
}

// ── 工程面契約（不涉及解析規則，但都是實際壞過或會壞的地方）──
{
    const html = await readFile('index.html', 'utf8');

    const sri = (src) => {
        const tag = html.match(new RegExp(`<script[^>]*${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'i'));
        return tag ? { integrity: /integrity="sha384-[^"]+"/.test(tag[0]), crossorigin: /crossorigin=/.test(tag[0]) } : null;
    };
    const pdfSri = sri('pdf.js/2.10.377/pdf.min.js');
    const xlsxSri = sri('xlsx/0.18.5/xlsx.full.min.js');
    if (!pdfSri || !pdfSri.integrity || !pdfSri.crossorigin
        || !xlsxSri || !xlsxSri.integrity || !xlsxSri.crossorigin) {
        failed++;
        console.error('✗ CDN 程式庫缺少 SRI/crossorigin（供應鏈硬化）');
        console.error(`    pdf.js=${JSON.stringify(pdfSri)} xlsx=${JSON.stringify(xlsxSri)}`);
    } else {
        console.log('✓ CDN 程式庫都有 SRI + crossorigin');
    }

    if (!/<span id="msg" role="status" aria-live="polite">/.test(html) || !/for="f"/.test(html)) {
        failed++;
        console.error('✗ 進度訊息缺少 aria-live 或檔案輸入缺少 label');
    } else {
        console.log('✓ 進度訊息有 aria-live、檔案輸入有 label（螢幕報讀器可讀）');
    }

    // _parse 必須釋放 pdf.js 文件：舊版只 destroy PDFium 的偽文件，pdf.js 的 document
    // 會一直留在記憶體（4.6MB／341 頁的預算書連續解析會累積）。
    const ctx = loadTool(html);
    let destroyed = 0;
    const fakeDoc = {
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
        destroy: async () => { destroyed++; },
    };
    ctx.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(fakeDoc) }) };
    ctx.importModule = null;
    const before = vm.runInContext('_parseToken', ctx);
    await ctx._parse(new Uint8Array([1, 2, 3])).catch(() => {});
    const after = vm.runInContext('_parseToken', ctx);
    if (destroyed < 1) {
        failed++;
        console.error('✗ _parse 沒有釋放 pdf.js document（destroy 未被呼叫）');
    } else {
        console.log('✓ _parse 會釋放 pdf.js document（destroy 已呼叫）');
    }
    if (after !== before + 1) {
        failed++;
        console.error(`✗ _parse 沒有遞增世代編號（${before} → ${after}）`);
    } else {
        console.log('✓ _parse 每次呼叫都會遞增世代編號（舊結果會被丟棄）');
    }

    // CMap 是「Big5 內文字型讀不讀得出來」的關鍵：index.html 必須把它指向 repo 內
    // 自帶的同源 cmaps/，而那個資料夾必須真的有樣本需要的字元對應表。
    // 少了任何一邊，三份 2-byte CID 的文件就會退回較弱的 PDFium（或整個讀不出來）。
    const cmapCtx = loadTool(html);
    const cmapUrl = vm.runInContext('_CMAP_URL', cmapCtx);
    if (cmapUrl !== 'http://127.0.0.1:8963/cmaps/') {
        failed++;
        console.error(`✗ _CMAP_URL 不是同源的 cmaps/（實際 ${cmapUrl}）`);
    } else if (!/cMapUrl:\s*_CMAP_URL/.test(html) || !/cMapPacked:\s*true/.test(html)) {
        failed++;
        console.error('✗ getDocument 沒有帶 cMapUrl/cMapPacked');
    } else {
        console.log('✓ CMap 指向同源 cmaps/，且 getDocument 有帶 cMapUrl + cMapPacked');
    }
    // 這五個是現有 7 份樣本實際讀取的字元對應表（其餘 160 幾個同批自帶，供其他 CJK 文件用）
    const needMaps = ['Adobe-CNS1-UCS2.bcmap', 'UniCNS-UCS2-H.bcmap', 'ETen-B5-H.bcmap',
        'ETenms-B5-H.bcmap', 'UniCNS-UTF16-H.bcmap'];
    const missingMaps = needMaps.filter(f => !existsSync(new URL('cmaps/' + f, import.meta.url)));
    if (missingMaps.length) {
        failed++;
        console.error(`✗ cmaps/ 缺少樣本需要的字元對應表：${missingMaps.join('、')}`);
    } else {
        console.log(`✓ cmaps/ 自帶 ${needMaps.length} 個樣本需要的字元對應表（Big5/CNS）`);
    }

    // 引擎評分的規則（哪個引擎的結果該留下）必須是「先能自圓其說、再比資料量」。
    // 這條規則同時決定瀏覽器與 PDFium 後備路徑的行為，所以直接驗語意。
    const rank = loadTool(html);
    const good = [
        { level: '用途別一級', planCode: 'P', branchCode: '01', l1Code: '1000', amount: '100' },
        { level: '明細', planCode: 'P', branchCode: '01', l1Code: '1000', l2Code: '1001', amount: '100' },
    ];
    const bad = [
        { level: '用途別一級', planCode: 'P', branchCode: '01', l1Code: '1000', amount: '100' },
        { level: '明細', planCode: 'P', branchCode: '01', l1Code: '1000', l2Code: '1001', amount: '60' },
    ];
    const goodMore = good.concat([{ level: '明細', planCode: 'P', branchCode: '01', l1Code: '1000', l2Code: '1001', amount: '0' }]);
    const better = rank._isBetterEngine;
    if (!(better(good, bad) === true && better(bad, good) === false
        && better(goodMore, good) === true && better(good, goodMore) === false
        && better([], good) === false && better(good, []) === true)) {
        failed++;
        console.error('✗ 引擎評分規則不是「先比驗算相符、再比列數」');
    } else {
        console.log('✓ 引擎評分規則：先比四層驗算相符數，再比列數（空的永遠不贏）');
    }

    // 保守式修復的 DFS 必須有節點上限：病態輸入不能把分頁卡住。
    const ctx2 = loadTool(html);
    // 每列 123456 都能切成 4 種金額（123456／23456／3456／456），20 列就是 4^20 ≈ 1.1e12
    // 種組合；目標訂在總和以下、又大到剪枝幾乎不會生效，藉此逼出節點上限。
    const acct = { level: '用途別一級', amount: '2000000', planName: 'P', branchName: 'B', l1Code: '1000', l1Name: '人事費', page: 1 };
    const details = Array.from({ length: 20 }, (_, i) => ({
        level: '明細', amount: '123456', price: '', planName: 'P', branchName: 'B',
        l2Code: '1001', l2Name: '約聘僱人員待遇', page: i + 2, desc: 'x',
    }));
    const t0 = Date.now();
    ctx2._repairDetailAmounts([acct, ...details]);
    const ms = Date.now() - t0;
    const notes = vm.runInContext('_repairNotes', ctx2);
    if (notes.length !== 1 || ms > 2000) {
        failed++;
        console.error(`✗ 修復 DFS 沒有正確套用節點上限（notes=${notes.length}、耗時 ${ms}ms）`);
    } else {
        console.log(`✓ 修復 DFS 有節點上限：病態輸入 ${ms}ms 內放棄並記錄 ${notes.length} 筆未修復`);
    }
}

if (failed) {
    console.error(`\n${failed}份不符。`);
    process.exit(1);
}

console.log('\n全部通過。');
