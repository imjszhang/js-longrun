import fs from 'node:fs';
import assert from 'node:assert/strict';
const p=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
assert.equal(p.name,'js-longrun');assert.equal(p.license,'MIT');assert.equal(p.publishConfig.tag,'alpha');
for(const file of [p.bin['js-longrun'],...Object.values(p.exports).filter(x=>!x.includes('*')),'LICENSE','README.md'])assert.ok(fs.existsSync(new URL('../'+file,import.meta.url)),file);
assert.ok(!p.dependencies?.['js-agent-runtime']);
console.log('Package entries and release metadata verified');
