// 回歸測試：用真實 PDF 驗證解析結果沒有退化。
// 直接載入 index.html 內的解析核心（parseLocalDoc / reconcile），不自行複寫規則。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { init as pdfiumInit } from '@embedpdf/pdfium';
import { readFile } from 'fs/promises';
import vm from 'node:vm';

const EXPECT = {
    '臺北市': { file: 'examples/taipei-116.pdf', agency: '臺北市政府主計處', plans: 4, branches: 14, l1: 20, l2: 53, detail: 97, rows: 192 },
    '臺中市': { file: 'examples/taichung-115.pdf', agency: '臺中市政府主計處', plans: 7, branches: 5, l1: 17, l2: 79, detail: 123, rows: 267 },
    // 以下兩份的內文字型 pdf.js 解不開（g_font_error），走 PDFium 後備引擎——
    // 引擎載入是環境膠水（node 用 npm 套件、瀏覽器用 CDN），但「字元流→items」的轉換
    // 與偽文件物件都取自 index.html 的同一份程式碼，測試不自行複寫。
    '高雄市': { file: 'examples/kaohsiung-115.pdf', engine: 'pdfium', agency: '高雄市政府主計處', plans: 4, branches: 8, l1: 18, l2: 72, detail: 115, rows: 220 },
    '新北市': { file: 'examples/newtaipei-115.pdf', engine: 'pdfium', agency: '新北市政府主計處', plans: 11, branches: 6, l1: 10, l2: 38, detail: 72, rows: 177 },
};
let _pdfiumLib = null;

function loadTool(html) {
    const js = html.split('<script>')[1].split('</script>')[0]
        .replace(/pdfjsLib\.GlobalWorkerOptions[^\n]*\n/, '');
    const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', addEventListener() { } };
    const ctx = {
        console, document: { getElementById: () => stub, createElement: () => stub },
        window: {}, pdfjsLib: { GlobalWorkerOptions: {} },
        URL: { createObjectURL: () => '' }, Blob: function () { },
    };
    ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(js, ctx);
    return ctx;
}

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
let failed = 0;
for (const [name, want] of Object.entries(EXPECT)) {
    const ctx = loadTool(html);
    const path = new URL(want.file, import.meta.url);
    const data = new Uint8Array(await readFile(path));
    let pdf;
    if (want.engine === 'pdfium') {
        if (!_pdfiumLib) { _pdfiumLib = await pdfiumInit(); _pdfiumLib.PDFiumExt_Init(); }
        pdf = ctx._pdfiumFakeDoc(_pdfiumLib, data);
    } else {
        pdf = await getDocument({ data }).promise;
    }
    const rows = await ctx.parseLocalDoc(pdf);
    if (pdf.destroy) pdf.destroy();
    const by = l => rows.filter(r => r.level === l).length;
    const got = {
        agency: ctx.detectedAgency(),
        plans: new Set(rows.map(r => r.planCode)).size,
        branches: by('分支計畫'), l1: by('用途別一級'), l2: by('用途別二級'), detail: by('明細'), rows: rows.length,
    };
    const errs = Object.entries(want).filter(([k, v]) => k !== 'file' && k !== 'engine' && got[k] !== v)
        .map(([k, v]) => `${k}: 期望 ${v}，實際 ${got[k]}`);
    const bad = ctx.reconcile(rows);
    errs.push(...bad.map(m => '驗算不符 → ' + m));
    if (errs.length) {
        failed++; console.error(`✗ ${name}`); errs.slice(0, 10).forEach(e => console.error('    ' + e));
        console.error(`    （實際：${got.plans} 計畫／${got.branches} 分支／${got.l1} 一級／${got.l2} 二級／${got.detail} 明細／共 ${got.rows} 列）`);
    } else {
        console.log(`✓ ${name}  ${got.agency}｜${got.plans} 計畫／${got.branches} 分支／${got.l1} 一級／${got.l2} 二級／${got.detail} 明細｜共 ${got.rows} 列｜四層驗算 0 不符`);
    }
}
if (failed) { console.error(`\n${failed} 份不符。`); process.exit(1); }
console.log('\n全部通過。');
