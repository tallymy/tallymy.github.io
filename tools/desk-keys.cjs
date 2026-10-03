const fs = require('node:fs'); const keys = new Set();
for(const name of ['desk-host','desk-client'])for(const m of fs.readFileSync(__dirname+'/../js/'+name+'.js','utf8').matchAll(/\bt\('([^']*)'/g))keys.add(m[1]);
console.log(JSON.stringify([...keys],null,2));
