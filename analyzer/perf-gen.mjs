import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const N = Number(process.env.PERF_N ?? 600);
const F = Number(process.env.PERF_F ?? 160);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xxe-perf-"));
fs.writeFileSync(path.join(root,"package.json"), JSON.stringify({name:"perf",private:true,workspaces:["packages/*"]}));
const mk=(p,c)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),c);};
mk("packages/common-config/package.json", JSON.stringify({name:"@x/cfg",main:"src/index.ts"}));
mk("packages/common-config/src/index.ts", "export function assertNoDoctype(x:string){if(/<!DOCTYPE/.test(x))throw 1;}\nexport const secureConfig={allowDtd:false,resolveExternalEntities:false};\n");
mk("packages/parser-wrapper/package.json", JSON.stringify({name:"@x/pw",main:"src/index.ts",dependencies:{"@x/cfg":"workspace:*"}}));
mk("packages/doc-service/package.json", JSON.stringify({name:"@x/svc",main:"src/index.ts",dependencies:{"@x/pw":"workspace:*"}}));
let pwIndex="", svcIndex="";
for(let i=0;i<N;i++){
  let s=`import { DOMParser } from "@xmldom/xmldom";\nimport sax from "sax";\nimport { parseString } from "xml2js";\nexport function expandEntities${i}(xml:string):string{return xml.replace(/<!ENTITY/g,"");}\n`;
  const calleeNames=[];
  for(let j=0;j<F;j++){
    const kind=j%4; const prefix=["dom","sax","bind","ent"][kind]; const n=`${prefix}Fn${i}_${j}`;
    calleeNames.push(n);
    if(kind===0)s+=`export function ${n}(xml:string):Document{return new DOMParser().parseFromString(xml,"text/xml");}\n`;
    else if(kind===1)s+=`export function ${n}(xml:string):string[]{const p=sax.parser(true);p.write(xml).close();return [];}\n`;
    else if(kind===2)s+=`export function ${n}(xml:string,done:any):void{parseString(xml,{explicitArray:false},done);}\n`;
    else s+=`export function ${n}(xml:string):string{return expandEntities${i}(xml);}\n`;
  }
  mk(`packages/parser-wrapper/src/m${i}.ts`, s);
  pwIndex+=`export * from "./m${i}";\n`;
  let h=`import { ${calleeNames.join(", ")} } from "@x/pw";\n`;
  for(let j=0;j<F;j++){
    const kind=j%4; const n=calleeNames[j];
    h+=`export function entry${i}_${j}(req:any,cb:any){const xml=String(req.query.xml??req.query.doc??"");return ${kind===2?`${n}(xml,cb)`:`${n}(xml)`};}\n`;
  }
  mk(`packages/doc-service/src/h${i}.ts`, h);
  svcIndex+=`export * from "./h${i}";\n`;
}
mk("packages/parser-wrapper/src/index.ts", pwIndex);
mk("packages/doc-service/src/index.ts", svcIndex);
let lines=0;
(function walk(d){for(const e of fs.readdirSync(path.join(root,d),{withFileTypes:true})){const full=path.join(d,e.name);if(e.isDirectory())walk(full);else if(e.name.endsWith(".ts"))lines+=fs.readFileSync(path.join(root,full),"utf8").split("\n").length;}})("packages");
console.log(root);
console.log("LINES="+lines);
