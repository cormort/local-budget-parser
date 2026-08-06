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
        agencyTable: { pages: 2, checked: 4, issues: 0, unmatched: 0 },
    },
    '臺中市': {
        file: 'examples/taichung-115.pdf',
        agency: '臺中市政府主計處',
        plans: 7,
        branches: 5,
        l1: 22,
        l2: 89,
        detail: 144,
        rows: 267,
        agencyTable: { pages: 2, checked: 7, issues: 0, unmatched: 0 },
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
        l1: 19,
        l2: 73,
        detail: 116,
        rows: 220,
        agencyTable: { pages: 1, checked: 4, issues: 0, unmatched: 0 },
    },
    '新北市': {
        file: 'examples/newtaipei-115.pdf',
        engine: 'pdfium',
        agency: '新北市政府主計處',
        plans: 11,
        branches: 6,
        l1: 21,
        l2: 50,
        detail: 89,
        rows: 177,
        agencyTable: { pages: 4, checked: 11, issues: 2, unmatched: 0 },
    },
    // 主管單位預算（社會局＋所屬 5 機關，341 頁）。說明欄有大量公文字號，是
    //「工作計畫代碼只能取自表頭帶」這條規則的實證：放寬到整頁搜尋時，
    // 1140761123A 等公文字號會變成假計畫，其後數十頁明細全部改掛到假計畫下。
    // 案號與案名之間沒有破折號的寫法（「03115年度道路工程規劃設計」），
    // 是「案別不能只認破折號」這條規則的實證：只認破折號時案小計會被算進上一個科目。
    '臺北市新工處': {
        file: 'examples/taipei-newworks-116.pdf',
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
        engine: 'pdfium',
        agency: '新北市政府社會局',
        plans: 15,
        branches: 37,
        l1: 68,
        l2: 269,
        detail: 1161,
        rows: 1555,
        agencyTable: { pages: 10, checked: 14, issues: 4, unmatched: 1 },
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

    let rows, agencyCheck = null, agencyPages = 0;
    try {
        rows = await ctx.parseLocalDoc(pdf);
        // 工作計畫核對：拿同一本預算書的「歲出機關別預算表」當外部基準，驗工作計畫的
        // 編號、名稱與本年度預算數。四層加總驗算只證明本表自己前後一致（頂端的工作計畫
        // 預算數就取自本表自身），這條才驗得到那個頂端數字。
        const ag = await ctx.parseAgencyPlanTable(pdf);
        agencyPages = ag.pages;
        if (ag.pages) agencyCheck = ctx.crossCheckAgencyPlans(rows, ag);
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
        if (key === 'file' || key === 'engine' || key === 'extra' || key === 'agencyTable') continue;
        addMismatch(errors, key, expected, got[key]);
    }

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
    const pdf = await openPdf(ctx, data);

    let rows, agencyCheck = null, agencyPages = 0;
    try {
        rows = await ctx.parseLocalDoc(pdf);
        // 工作計畫核對：拿同一本預算書的「歲出機關別預算表」當外部基準，驗工作計畫的
        // 編號、名稱與本年度預算數。四層加總驗算只證明本表自己前後一致（頂端的工作計畫
        // 預算數就取自本表自身），這條才驗得到那個頂端數字。
        const ag = await ctx.parseAgencyPlanTable(pdf);
        agencyPages = ag.pages;
        if (ag.pages) agencyCheck = ctx.crossCheckAgencyPlans(rows, ag);
    } finally {
        if (pdf?.destroy) await pdf.destroy();
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

if (failed) {
    console.error(`\n${failed}份不符。`);
    process.exit(1);
}

console.log('\n全部通過。');
