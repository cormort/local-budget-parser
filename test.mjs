// 回歸測試：用真實 PDF 驗證解析結果沒有退化。
// 直接載入 index.html 內的解析核心（parseLocalDoc / reconcile），不自行複寫規則。

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { access, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const EXPECT = {
    '臺北市': {
        file: 'examples/taipei-116.pdf',
        agency: '臺北市政府主計處',
        plans: 4,
        branches: 14,
        l1: 20,
        l2: 53,
        detail: 97,
        rows: 192,
    },
    '臺中市': {
        file: 'examples/taichung-115.pdf',
        agency: '臺中市政府主計處',
        plans: 7,
        branches: 5,
        l1: 17,
        l2: 79,
        detail: 123,
        rows: 267,
    },
    // 以下兩份的內文字型 pdf.js 無法解讀，改走 PDFium 後備引擎。
    // 引擎載入是 Node.js 測試環境的膠水；字元流轉換與偽文件物件
    // 均直接使用 index.html 內的 _pdfiumFakeDoc()，不在測試中複寫。
    '高雄市': {
        file: 'examples/kaohsiung-115.pdf',
        engine: 'pdfium',
        agency: '高雄市政府主計處',
        plans: 4,
        branches: 8,
        l1: 18,
        l2: 72,
        detail: 115,
        rows: 220,
    },
    '新北市': {
        file: 'examples/newtaipei-115.pdf',
        engine: 'pdfium',
        agency: '新北市政府主計處',
        plans: 11,
        branches: 6,
        l1: 10,
        l2: 38,
        detail: 72,
        rows: 177,
    },
};

// 社會局案例若已放入 examples/，自動加入回歸測試。
// 尚未加入檔案時不會讓既有測試失敗，但會顯示略過提示。
const SOCIAL_CASE = {
    name: '臺北市政府社會局',
    file: 'examples/taipei-social-116.pdf',
    agency: '臺北市政府社會局',
};

let _pdfiumLib = null;

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
        },
        window: {},
        pdfjsLib: { GlobalWorkerOptions: {} },
        URL: {
            createObjectURL: () => '',
            revokeObjectURL() {},
        },
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
    return getDocument({ data }).promise;
}

async function runBaselineCase(name, want, html) {
    const ctx = loadTool(html);
    const data = new Uint8Array(await readFile(new URL(want.file, import.meta.url)));
    const pdf = await openPdf(ctx, data, want.engine);

    let rows;
    try {
        rows = await ctx.parseLocalDoc(pdf);
    } finally {
        if (pdf?.destroy) await pdf.destroy();
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
        if (key === 'file' || key === 'engine') continue;
        addMismatch(errors, key, expected, got[key]);
    }

    // 新版共同規則：總經費列若存在，必須全部標示 excluded=true。
    const totalCostRows = rows.filter(r => r.level === '總經費');
    const activeTotalCostRows = totalCostRows.filter(r => r.excluded !== true);
    if (activeTotalCostRows.length) {
        errors.push(`總經費排除旗標錯誤：${activeTotalCostRows.length} 列未標示 excluded=true`);
    }

    // 「總工程費／總經費」不得仍被歸類為一般明細。
    const leakedTotalCostDetails = rows.filter(r =>
        r.level === '明細'
        && /(總工程費|總經費)(?:明細)?如下/.test((r.desc || '').replace(/[\s　]/g, ''))
    );
    if (leakedTotalCostDetails.length) {
        errors.push(`總經費誤入一般明細：${leakedTotalCostDetails.length} 列`);
    }

    const issues = ctx.reconcile(rows);
    errors.push(...issues.map(issue => '驗算不符 → ' + issueText(issue)));

    return { errors, got, rows, ctx, totalCostRows };
}

async function runSocialCase(html) {
    const ctx = loadTool(html);
    const data = new Uint8Array(await readFile(new URL(SOCIAL_CASE.file, import.meta.url)));
    const pdf = await openPdf(ctx, data);

    let rows;
    try {
        rows = await ctx.parseLocalDoc(pdf);
    } finally {
        if (pdf?.destroy) await pdf.destroy();
    }

    const errors = [];
    addMismatch(errors, 'agency', SOCIAL_CASE.agency, ctx.detectedAgency());

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

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
let failed = 0;

for (const [name, want] of Object.entries(EXPECT)) {
    try {
        const { errors, got, totalCostRows } = await runBaselineCase(name, want, html);
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
                + `${totalCostRows.length}總經費｜共${got.rows}列｜四層驗算0不符`,
            );
        }
    } catch (error) {
        failed++;
        console.error(`✗ ${name}`);
        console.error('    測試執行失敗：' + (error?.stack || error));
    }
}

if (await fileExists(SOCIAL_CASE.file)) {
    try {
        const { errors, got, repairs } = await runSocialCase(html);
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
                + `共${got.rows}列｜四層驗算0不符`,
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

if (failed) {
    console.error(`\n${failed}份不符。`);
    process.exit(1);
}

console.log('\n全部通過。');
