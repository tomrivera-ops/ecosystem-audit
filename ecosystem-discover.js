#!/usr/bin/env node
/**
 * ecosystem-discover.js — deterministic, zero-API repo inventory (JS + Python + Go).
 *   node ecosystem-discover.js /path/to/repos-parent-dir
 *   node ecosystem-discover.js ./repoA ./repoB ...
 * Output: ./ecosystem-inventory/<slug>.yaml + _index.yaml. No LLM. No network.
 * internal_dependencies = ROOT package graph only (empty here). Real edges: coupling-scan.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules','.git','dist','build','.next','coverage','.turbo','out','.cache','vendor','__pycache__','.venv','venv']);

const FRAMEWORKS   = ['react','next','express','fastify','@nestjs/core','koa','vue','svelte','@angular/core','remix','hono','vite','astro'];
const INTEGRATIONS = ['@anthropic-ai/sdk','openai','stripe','aws-sdk','@aws-sdk/client-s3','@google-cloud/storage','twilio','@sendgrid/mail','octokit','@octokit/rest','firebase-admin','@slack/web-api'];
const OBSERVABILITY= ['winston','pino','@opentelemetry/api','@sentry/node','@sentry/react','datadog-metrics','prom-client'];
const AUTH         = ['passport','jsonwebtoken','next-auth','@auth/core','casbin','@casl/ability','jose','bcrypt','argon2','@clerk/nextjs'];
const DATASTORES   = ['pg','mysql','mysql2','mongodb','mongoose','redis','ioredis','prisma','@prisma/client','drizzle-orm','kafkajs','amqplib','@aws-sdk/client-dynamodb','better-sqlite3','typeorm'];
const TEST_FW      = ['jest','vitest','mocha','@playwright/test','cypress','ava'];

const PY_FRAMEWORKS   = ['fastapi','flask','django','starlette','aiohttp','tornado','langchain','llama-index','pydantic'];
const PY_INTEGRATIONS = ['anthropic','openai','boto3','stripe','google-cloud-storage','twilio','sendgrid','slack-sdk'];
const PY_OBSERVABILITY= ['opentelemetry-api','sentry-sdk','structlog','prometheus-client','loguru'];
const PY_AUTH         = ['pyjwt','authlib','python-jose','passlib','bcrypt'];
const PY_DATASTORES   = ['psycopg2','psycopg','asyncpg','sqlalchemy','pymongo','redis','aioredis','motor','alembic'];
const PY_TEST         = ['pytest','tox','nox'];

// Go module-path prefixes
const GO_FRAMEWORKS   = ['github.com/gin-gonic/gin','github.com/labstack/echo','github.com/gofiber/fiber','google.golang.org/grpc','github.com/go-chi/chi','github.com/gorilla/mux','github.com/open-policy-agent/opa','github.com/spf13/cobra'];
const GO_INTEGRATIONS = ['github.com/aws/aws-sdk-go','cloud.google.com/go','github.com/stripe/stripe-go','github.com/slack-go/slack'];
const GO_OBSERVABILITY= ['go.opentelemetry.io/otel','github.com/prometheus/client_golang','github.com/sirupsen/logrus','go.uber.org/zap'];
const GO_AUTH         = ['github.com/golang-jwt/jwt','github.com/casbin/casbin'];
const GO_DATASTORES   = ['github.com/lib/pq','gorm.io/gorm','go.mongodb.org/mongo-driver','github.com/redis/go-redis','github.com/jackc/pgx'];

const EXT_LANG = { '.ts':'TypeScript','.tsx':'TypeScript','.js':'JavaScript','.jsx':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript','.py':'Python','.go':'Go','.rs':'Rust','.java':'Java','.rb':'Ruby','.cs':'C#','.php':'PHP' };

function safeJSON(p){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return null; } }
function exists(p){ try{ fs.accessSync(p); return true; }catch{ return false; } }
function scalar(v){ return v==='UNKNOWN'?'UNKNOWN':JSON.stringify(v); }
function normPy(s){ return String(s).toLowerCase().replace(/_/g,'-'); }
function* walk(dir){ let e; try{ e=fs.readdirSync(dir,{withFileTypes:true}); }catch{ return; }
  for(const x of e){ if(x.isDirectory()){ if(!IGNORE.has(x.name)) yield* walk(path.join(dir,x.name)); } else yield path.join(dir,x.name); } }
function emit(lines,key,val,indent){ const pad='  '.repeat(indent);
  if(Array.isArray(val)){ if(val.length===0){ lines.push(`${pad}${key}: []`); return; } lines.push(`${pad}${key}:`); for(const v of val) lines.push(`${pad}  - ${scalar(v)}`); }
  else if(val&&typeof val==='object'){ lines.push(`${pad}${key}:`); for(const [k,v] of Object.entries(val)) emit(lines,k,v,indent+1); }
  else lines.push(`${pad}${key}: ${scalar(val)}`); }

function parsePyManifest(root){ const res={found:false,name:null,description:null,deps:[]};
  const pp=path.join(root,'pyproject.toml'), rq=path.join(root,'requirements.txt');
  if(exists(pp)){ res.found=true; let t=''; try{t=fs.readFileSync(pp,'utf8');}catch{}
    const nm=t.match(/^\s*name\s*=\s*["']([^"']+)["']/m); if(nm) res.name=nm[1];
    const de=t.match(/^\s*description\s*=\s*["']([^"']+)["']/m); if(de) res.description=de[1];
    const arr=t.match(/dependencies\s*=\s*\[([^\]]*)\]/s); if(arr) for(const m of arr[1].matchAll(/["']([A-Za-z0-9_.\-]+)/g)) res.deps.push(m[1]);
    const pt=t.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/); if(pt) for(const line of pt[1].split('\n')){ const mm=line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=/); if(mm&&mm[1].toLowerCase()!=='python') res.deps.push(mm[1]); } }
  if(exists(rq)){ res.found=true; let t=''; try{t=fs.readFileSync(rq,'utf8');}catch{}
    for(const line of t.split('\n')){ const s=line.trim(); if(!s||s.startsWith('#')||s.startsWith('-')) continue; const m=s.match(/^([A-Za-z0-9_.\-]+)/); if(m) res.deps.push(m[1]); } }
  return res; }

function parseGoMod(root){ const res={found:false,name:null,deps:[]}; const gm=path.join(root,'go.mod'); if(!exists(gm)) return res;
  res.found=true; let t=''; try{t=fs.readFileSync(gm,'utf8');}catch{}
  const nm=t.match(/^\s*module\s+(\S+)/m); if(nm) res.name=nm[1];
  const block=t.match(/require\s*\(([\s\S]*?)\)/); if(block) for(const line of block[1].split('\n')){ const m=line.match(/^\s*(\S+)\s+v\S+/); if(m) res.deps.push(m[1]); }
  for(const m of t.matchAll(/^\s*require\s+(\S+)\s+v\S+/gm)) res.deps.push(m[1]);
  return res; }

function inventory(root){
  const slug=path.basename(root).toLowerCase().replace(/\s+/g,'-');
  const rel=(p)=>path.relative(root,p).replace(/\\/g,'/');
  const extCount={}, envVars=new Set(), contracts={openapi:[],proto:[],graphql:[],published_packages:[]};
  const configFiles=[], manifests=[], testDirs=new Set();
  for(const f of walk(root)){ const b=path.basename(f), ext=path.extname(f).toLowerCase(), r=rel(f);
    if(EXT_LANG[ext]) extCount[ext]=(extCount[ext]||0)+1;
    if(/^(package\.json|go\.mod|pyproject\.toml|Cargo\.toml|requirements\.txt|pom\.xml)$/.test(b)) manifests.push(r);
    if(/^Dockerfile/.test(b)||/docker-compose/.test(b)||ext==='.tf'||b==='Chart.yaml') configFiles.push(r);
    if(/openapi/i.test(b)&&/\.(ya?ml|json)$/.test(b)) contracts.openapi.push(r);
    if(ext==='.proto') contracts.proto.push(r);
    if(ext==='.graphql'||/schema\.graphql/.test(b)) contracts.graphql.push(r);
    if(/(^|\/)(tests?|__tests__|spec)(\/|$)/.test(r)||/\.(test|spec)\.[tj]sx?$/.test(b)||/test_.*\.py$/.test(b)) testDirs.add(r.split('/').slice(0,-1).join('/')||'.');
    if(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py'].includes(ext)){ let src=''; try{src=fs.readFileSync(f,'utf8');}catch{}
      for(const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) envVars.add(m[1]);
      for(const m of src.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) envVars.add(m[1]);
      for(const m of src.matchAll(/os\.environ(?:\.get)?\[?['"]([A-Z0-9_]+)['"]/g)) envVars.add(m[1]); } }

  const totalCode=Object.values(extCount).reduce((a,b)=>a+b,0)||1; const langAgg={};
  for(const [ext,n] of Object.entries(extCount)) langAgg[EXT_LANG[ext]]=(langAgg[EXT_LANG[ext]]||0)+n;
  const langs=Object.entries(langAgg).sort((a,b)=>b[1]-a[1]);
  const primary_language=langs.length?langs[0][0]:'UNKNOWN';
  const languages_detected=langs.map(([l,n])=>`${l}: ${Math.round((n/totalCode)*100)}%`);

  const pkg=safeJSON(path.join(root,'package.json'));
  const deps=pkg?{...(pkg.dependencies||{}),...(pkg.devDependencies||{})}:{};
  const depNames=Object.keys(deps);
  const pyMan=parsePyManifest(root); const pyDeps=pyMan.deps.map(normPy);
  const goMan=parseGoMod(root); const goDeps=goMan.deps;
  const hasJs=(l)=>l.filter(d=>depNames.includes(d));
  const hasPy=(l)=>l.filter(d=>pyDeps.includes(normPy(d)));
  const hasGo=(l)=>l.filter(e=>goDeps.some(d=>d===e||d.startsWith(e)));
  const detect=(js,py,go)=>[...new Set([...hasJs(js),...hasPy(py||[]),...hasGo(go||[])])];
  if(pkg&&pkg.name&&pkg.private!==true) contracts.published_packages.push(pkg.name);

  let pm='UNKNOWN';
  if(exists(path.join(root,'pnpm-lock.yaml'))) pm='pnpm';
  else if(exists(path.join(root,'yarn.lock'))) pm='yarn';
  else if(exists(path.join(root,'package-lock.json'))) pm='npm';
  else if(exists(path.join(root,'poetry.lock'))) pm='poetry';
  else if(exists(path.join(root,'uv.lock'))) pm='uv';
  else if(exists(path.join(root,'requirements.txt'))) pm='pip';
  else if(exists(path.join(root,'pyproject.toml'))) pm='pyproject';
  else if(exists(path.join(root,'go.mod'))) pm='go modules';
  else if(exists(path.join(root,'Cargo.lock'))) pm='cargo';

  const entrypoints=[];
  if(pkg&&pkg.main) entrypoints.push(pkg.main);
  if(pkg&&pkg.bin) entrypoints.push(...(typeof pkg.bin==='string'?[pkg.bin]:Object.values(pkg.bin)));
  for(const c of ['src/index.ts','src/main.ts','src/server.ts','index.ts','main.go','cmd/main.go','main.py','app/main.py','src/main.py','__main__.py','manage.py']) if(exists(path.join(root,c))) entrypoints.push(c);

  let ciSystem='UNKNOWN'; const wf=[];
  if(exists(path.join(root,'.github/workflows'))){ ciSystem='github-actions'; for(const f of fs.readdirSync(path.join(root,'.github/workflows'))) wf.push(`.github/workflows/${f}`); }
  else if(exists(path.join(root,'.circleci/config.yml'))) ciSystem='circleci';
  else if(exists(path.join(root,'.gitlab-ci.yml'))) ciSystem='gitlab-ci';

  const adr=exists(path.join(root,'docs/adr'))||exists(path.join(root,'docs/decisions'));
  const hasManifest=!!pkg||pyMan.found||goMan.found;

  const rec={
    repo:slug, verified_at:new Date().toISOString(),
    purpose_stated:(pkg&&pkg.description)?pkg.description:(pyMan.description||'UNKNOWN'),
    primary_language,
    languages_detected:languages_detected.length?languages_detected:['UNKNOWN'],
    frameworks:detect(FRAMEWORKS,PY_FRAMEWORKS,GO_FRAMEWORKS).length?detect(FRAMEWORKS,PY_FRAMEWORKS,GO_FRAMEWORKS):['UNKNOWN'],
    package_manager:pm,
    manifests:manifests.length?manifests:['UNKNOWN'],
    entrypoints:entrypoints.length?[...new Set(entrypoints)]:['UNKNOWN'],
    external_integrations:detect(INTEGRATIONS,PY_INTEGRATIONS,GO_INTEGRATIONS),
    published_contracts:{ openapi:contracts.openapi, proto:contracts.proto, graphql:contracts.graphql, published_packages:contracts.published_packages.length?contracts.published_packages:['UNKNOWN'] },
    internal_dependencies:[], _all_deps:depNames, _pkg_name:(pkg&&pkg.name)?pkg.name:null,
    env_and_secrets_refs:envVars.size?[...envVars].sort():['UNKNOWN'],
    config_files:configFiles.length?configFiles:['UNKNOWN'],
    ci_cd:{ system:ciSystem, workflow_files:wf.length?wf:['UNKNOWN'], deploy_targets:'UNKNOWN' },
    tests:{ frameworks:detect(TEST_FW,PY_TEST,[]).length?detect(TEST_FW,PY_TEST,[]):['UNKNOWN'], test_dirs:testDirs.size?[...testDirs]:['UNKNOWN'], coverage_config:(deps.nyc||deps.c8||exists(path.join(root,'.nycrc'))||pyDeps.includes('coverage')||pyDeps.includes('pytest-cov'))?'present':'absent' },
    docs:{ readme:exists(path.join(root,'README.md'))?'present':'absent', adr_dir:adr?'present':'absent', api_docs:(contracts.openapi.length||contracts.graphql.length)?'present':'absent' },
    observability:detect(OBSERVABILITY,PY_OBSERVABILITY,GO_OBSERVABILITY).length?detect(OBSERVABILITY,PY_OBSERVABILITY,GO_OBSERVABILITY):['UNKNOWN'],
    auth_mechanism:detect(AUTH,PY_AUTH,GO_AUTH).length?detect(AUTH,PY_AUTH,GO_AUTH):['UNKNOWN'],
    data_stores:detect(DATASTORES,PY_DATASTORES,GO_DATASTORES),
    confidence:hasManifest?'high':'low', gaps:[],
  };
  const g=[]; for(const [k,v] of Object.entries(rec)){ if(v==='UNKNOWN'||(Array.isArray(v)&&v.length===1&&v[0]==='UNKNOWN')) g.push(k); }
  if(!hasManifest) g.push('no JS/Python/Go manifest at root — extend classifier or check nested workspaces');
  rec.gaps=g.length?g:['none flagged by script — human should still confirm relationships'];
  return rec;
}

const args=process.argv.slice(2);
if(!args.length){ console.error('usage: node ecosystem-discover.js <parent-dir | repo-root...>'); process.exit(1); }
let roots=[];
if(args.length===1&&exists(args[0])&&fs.statSync(args[0]).isDirectory()){
  const parent=args[0];
  const children=fs.readdirSync(parent,{withFileTypes:true}).filter(e=>e.isDirectory()&&!IGNORE.has(e.name));
  const repoish=children.filter(e=>['.git','package.json','pyproject.toml','requirements.txt','go.mod'].some(m=>exists(path.join(parent,e.name,m))));
  roots=repoish.length?repoish.map(e=>path.join(parent,e.name)):[parent];
} else roots=args;

const outDir=path.resolve('ecosystem-inventory'); fs.mkdirSync(outDir,{recursive:true});
const records=roots.map(inventory);
const nameToSlug={}; for(const r of records) if(r._pkg_name) nameToSlug[r._pkg_name]=r.repo;
for(const r of records){ r.internal_dependencies=r._all_deps.filter(d=>nameToSlug[d]&&nameToSlug[d]!==r.repo).map(d=>`${d} (${nameToSlug[d]})`);
  if(!r.internal_dependencies.length) r.internal_dependencies=['UNKNOWN']; delete r._all_deps; delete r._pkg_name; }
const index={ generated_at:new Date().toISOString(), repos_inventoried:[], repos_found_not_inventoried:[] };
for(const r of records){ const lines=[]; for(const [k,v] of Object.entries(r)) emit(lines,k,v,0); fs.writeFileSync(path.join(outDir,`${r.repo}.yaml`),lines.join('\n')+'\n'); index.repos_inventoried.push(r.repo); }
const idx=[]; for(const [k,v] of Object.entries(index)) emit(idx,k,v,0); fs.writeFileSync(path.join(outDir,'_index.yaml'),idx.join('\n')+'\n');
console.log(`Wrote ${records.length} inventories -> ${outDir}`); console.log('API calls used: 0');
