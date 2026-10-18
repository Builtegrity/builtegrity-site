import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const pairs=['index.html','preview/console/index.html','preview/payment/index.html'];
for(const path of pairs){
  const a=readFileSync(path,'utf8'),b=readFileSync(join('public',path),'utf8');
  assert.equal(a,b,`Root/public mirror differs: ${path}`);
  assert(!/sk_live_|sk_test_|test-tx-0001-token|<form\b/i.test(a),'No live credentials, test customer token or payment forms');
  for(const match of a.matchAll(/href="(\/[^"#?]*)"/g)){
    const route=match[1];
    if(route==='/')continue;
    if(route==='/styles.css')assert(existsSync('styles.css'),'Styles must publish at root');
    else assert(existsSync(join('.',route,'index.html')),`Broken Pages navigation ${path} -> ${route}`);
  }
}
for(const path of ['console/index.html','pay/index.html'])assert(existsSync(path),`Legacy link must safely resolve: ${path}`);
const p=readFileSync('preview/payment/index.html','utf8');
assert(/disabled/.test(p)&&!/fetch\(|checkout\/sessions|<script/i.test(p),'Payment preview must remain inert');
console.log('Public GitHub Pages preview routes, navigation, and inert payment screen: PASS');
