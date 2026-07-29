// 回歸測試：用真實 PDF 驗證解析結果沒有退化。
// 直接載入 index.html 內的解析核心（parseLocalDoc / reconcile），不自行複寫規則。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile } from 'fs/promises';
import vm from 'node:vm';

const EXPECT = {
    '臺北市': { file: 'examples/taipei-116.pdf', agency: '臺北市政府主計處' },
    '臺中市': { file: 'examples/taichung-115.pdf', agency: '臺中市政府主計處' },
};

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
    const pdf = await getDocument({ data: new Uint8Array(await readFile(path)) }).promise;
    const rows = await ctx.parseLocalDoc(pdf);
    const by = l => rows.filter(r => r.level === l).length;
    const got = {
        agency: ctx.detectedAgency(),
        plans: new Set(rows.map(r => r.planCode)).size,
        branches: by('分支計畫'), l1: by('用途別一級'), l2: by('用途別二級'), detail: by('明細'), rows: rows.length,
    };
    const errs = Object.entries(want).filter(([k, v]) => k !== 'file' && got[k] !== v)
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
