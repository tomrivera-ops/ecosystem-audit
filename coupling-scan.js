#!/usr/bin/env node
/**
 * coupling-scan.js — deterministic cross-repo coupling graph. Zero API.
 *   node coupling-scan.js /path/to/repos-parent-dir  ->  ./ecosystem-inventory/_coupling.yaml
 *
 * Signals: (1) nested package.json name<->dep edges + vendored-copy duplication,
 * (2) python cross-repo import edges, (3) env-URL wiring intensity. Cycles via Tarjan SCC.
 *
 * Edge integrity rules (avoid false-dirty):
 *   - an edge counts only when the imported/depended name has EXACTLY ONE owner repo
 *     (multi-owner names are vendored duplication, reported separately, not edges);
 *   - python generic module names (app/core/api/utils/...) are never edges;
 *   - consumer-side shadow: local module files + namespace dirs block cross-repo edges;
 *   - third-party imports (openai, etc.) never resolve to vendored wrappers.
 *   - dev-audit is excluded separator-robustly (single or double underscore).
 */
'use strict';
const fs=require('fs'); const path=require('path');
const IGNORE=new Set(['node_modules','.git','dist','build','.next','coverage','.turbo','out','.cache','vendor','__pycache__','.venv','venv']);
const EXCLUDE=new Set(['tomrivera-ops__dev-audit']); // audit-snapshot repo that vendors the ecosystem
const normU=s=>s.replace(/_+/g,'_'); const EXCLUDE_N=new Set([...EXCLUDE].map(normU));
const TEXT_EXT=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.env','.yaml','.yml','.json','.md','.sh','.tf','.example']);
const PY_GENERIC=new Set(['app','core','api','utils','util','models','model','schemas','schema','config','common','lib','src','tests','test','main','services','service','routes','route','db','database','auth','server','client','shared','types','helpers','helper','base','settings','handlers','middleware','views','controllers','internal','pkg','cmd','apps','domain']);
const PY_THIRDPARTY=new Set(['openai','anthropic','requests','httpx','numpy','pandas','pydantic','fastapi','flask','django','starlette','uvicorn','sqlalchemy','redis','boto3','aiohttp','celery','langchain','dotenv','setuptools','typing_extensions','pytest','click','yaml','jinja2','aioredis','psycopg2','pymongo','asyncpg','os','sys','json','logging','datetime','pathlib']);

function exists(p){ try{fs.accessSync(p);return true;}catch{return false;} }
function scalar(v){ return v==='UNKNOWN'?'UNKNOWN':JSON.stringify(v); }
function* walk(dir){ let e; try{e=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const x of e){ if(x.isDirectory()){ if(!IGNORE.has(x.name)) yield* walk(path.join(dir,x.name)); } else yield path.join(dir,x.name); } }
function emit(lines,key,val,indent){ const pad='  '.repeat(indent);
  if(Array.isArray(val)){ if(val.length===0){ lines.push(`${pad}${key}: []`); return; } lines.push(`${pad}${key}:`);
    for(const v of val){ if(v&&typeof v==='object'){ lines.push(`${pad}  -`); for(const [k,vv] of Object.entries(v)) emit(lines,k,vv,indent+2); } else lines.push(`${pad}  - ${scalar(v)}`); } }
  else if(val&&typeof val==='object'){ lines.push(`${pad}${key}:`); for(const [k,v] of Object.entries(val)) emit(lines,k,v,indent+1); }
  else lines.push(`${pad}${key}: ${scalar(val)}`); }

const parent=process.argv[2];
if(!parent||!exists(parent)){ console.error('usage: node coupling-scan.js <repos-parent-dir>'); process.exit(1); }
const repos=fs.readdirSync(parent,{withFileTypes:true}).filter(e=>e.isDirectory()&&!IGNORE.has(e.name)&&!EXCLUDE_N.has(normU(e.name))).map(e=>e.name);

const provJs={}, consJs={}, provPy={}, consPy={}, envWiring={}, localMods={};
for(const repo of repos){ const root=path.join(parent,repo); consJs[repo]=new Set(); consPy[repo]=new Set(); localMods[repo]=new Set(); envWiring[repo]={files:new Set(),names:new Set()};
  for(const f of walk(root)){ const b=path.basename(f), ext=path.extname(f).toLowerCase(), rel=path.relative(root,f);
    if(b==='package.json'){ let j=null; try{j=JSON.parse(fs.readFileSync(f,'utf8'));}catch{}
      if(j){ if(j.name)(provJs[j.name]=provJs[j.name]||new Set()).add(repo); for(const d of Object.keys({...(j.dependencies||{}),...(j.devDependencies||{})})) consJs[repo].add(d); } continue; }
    if(b==='__init__.py'){ const parts=rel.split('/'); const dir=parts[parts.length-2]; if(dir)(provPy[dir]=provPy[dir]||new Set()).add(repo); }
    if(!TEXT_EXT.has(ext)) continue; let src=''; try{src=fs.readFileSync(f,'utf8');}catch{}
    if(ext==='.py'){ const base=b.slice(0,-3); if(base!=='__init__'&&base!=='__main__') localMods[repo].add(base); const pp=rel.split('/'); if(pp.length>=2) localMods[repo].add(pp[pp.length-2]); for(const m of src.matchAll(/^\s*from\s+([a-zA-Z0-9_]+)/gm)) consPy[repo].add(m[1]); for(const m of src.matchAll(/^\s*import\s+([a-zA-Z0-9_]+)/gm)) consPy[repo].add(m[1]); }
    let hit=false; for(const m of src.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_URL|NEXT_PUBLIC_[A-Z0-9_]+)\b/g)){ envWiring[repo].names.add(m[1]); hit=true; } if(hit) envWiring[repo].files.add(rel);
  } }

const jsEdges=[], pyEdges=[], dup=[];
for(const [name,set] of Object.entries(provJs)) if(set.size>1) dup.push({package:name,repos:[...set].sort()});
for(const repo of repos){
  for(const d of consJs[repo]){ const o=provJs[d]; if(!o||o.size!==1) continue; const owner=[...o][0]; if(owner!==repo) jsEdges.push({from:repo,to:owner,via:d}); }
  for(const mod of consPy[repo]){ if(PY_GENERIC.has(mod)||PY_THIRDPARTY.has(mod)) continue; if(localMods[repo].has(mod)) continue; const o=provPy[mod]; if(!o||o.size!==1) continue; const owner=[...o][0]; if(owner!==repo) pyEdges.push({from:repo,to:owner,via:mod}); }
}

const adj={}, nodes=new Set(repos);
for(const e of [...jsEdges,...pyEdges])(adj[e.from]=adj[e.from]||new Set()).add(e.to);
let idx=0; const stack=[], onStack={}, low={}, num={}, sccs=[];
function sc(v){ num[v]=low[v]=idx++; stack.push(v); onStack[v]=true;
  for(const w of (adj[v]||[])){ if(num[w]===undefined){ sc(w); low[v]=Math.min(low[v],low[w]); } else if(onStack[w]) low[v]=Math.min(low[v],num[w]); }
  if(low[v]===num[v]){ const comp=[]; let w; do{ w=stack.pop(); onStack[w]=false; comp.push(w); }while(w!==v); if(comp.length>1) sccs.push(comp.sort()); } }
for(const v of nodes) if(num[v]===undefined) sc(v);

const envSummary=Object.entries(envWiring).map(([repo,w])=>({repo,url_env_files:w.files.size,env_names:[...w.names].sort()})).filter(x=>x.url_env_files>0).sort((a,b)=>b.url_env_files-a.url_env_files);
const out={ generated_at:new Date().toISOString(), scope:{repos_scanned:repos.length,excluded:[...EXCLUDE]},
  duplication_vendored_copies:dup.sort((a,b)=>b.repos.length-a.repos.length),
  js_workspace_edges:jsEdges, python_import_edges:pyEdges, cycle_groups:sccs.map(c=>({members:c})),
  env_url_wiring:envSummary,
  scoring_hints:{ vendored_copy_count:dup.length, cycle_group_count:sccs.length, js_edge_count:jsEdges.length, py_edge_count:pyEdges.length } };
const outDir=path.resolve('ecosystem-inventory'); fs.mkdirSync(outDir,{recursive:true});
const lines=[]; for(const [k,v] of Object.entries(out)) emit(lines,k,v,0); fs.writeFileSync(path.join(outDir,'_coupling.yaml'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(outDir,'_coupling.json'),JSON.stringify(out,null,2)+'\n');
console.log(`_coupling.yaml: ${dup.length} dup, ${jsEdges.length} js edges, ${pyEdges.length} py edges, ${sccs.length} cycle groups`);
console.log('API calls used: 0');
