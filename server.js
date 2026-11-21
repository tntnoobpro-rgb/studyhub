'use strict';
// StudyHub PostgreSQL (Neon) backend. Preserves original /api routes and public UI.
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Configure it in Render > Environment.');
  process.exit(1); // Never fall back to an ephemeral SQLite database.
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const fail = (res, code, message) => res.status(code).json({ error: message });
const q = (sql, params=[]) => pool.query(sql, params);
const one = async (sql, params=[]) => (await q(sql,params)).rows[0] || null;
const wrapped = fn => (req,res,next) => Promise.resolve().then(()=>fn(req,res,next)).catch(next);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, prompt TEXT NOT NULL, options_json TEXT NOT NULL, answers_json TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0, explanation TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT ''
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_question_set ON questions(set_id,position)');
  await q(`CREATE TABLE IF NOT EXISTS progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,set_id)
  )`);
  // Snapshots protect against accidental overwriting or deletion inside the editor.
  await q(`CREATE TABLE IF NOT EXISTS question_revisions (
    revision_id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    saved_at TEXT NOT NULL, questions_json TEXT NOT NULL
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_revisions_set ON question_revisions(set_id,saved_at DESC)');
}

function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v=>{
    const i=v.indexOf('='); return [v.slice(0,i).trim(),v.slice(i+1).trim()];
  }));
}
async function me(req) {
  const token=readCookies(req).studyhub_session;
  if(!token)return null;
  return one('SELECT users.id,users.email,users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=$1 AND expires_at>$2',
    [crypto.createHash('sha256').update(token).digest('hex'), Date.now()]);
}
async function auth(req,res,next) {
  req.user=await me(req);
  if(!req.user) return fail(res,401,'Vui lòng đăng nhập để tiếp tục.');
  next();
}
const getSet = id => one('SELECT sets.*,users.name AS owner_name FROM sets JOIN users ON users.id=sets.owner_id WHERE sets.id=$1',[id]);
const canRead = (s,u) => !!s && (s.visibility!=='private'||(u&&u.id===s.owner_id));
async function owner(req,res,next) {
  req.user=await me(req);
  req.studySet=await getSet(req.params.id);
  if(!req.studySet)return fail(res,404,'Không tìm thấy bộ học.');
  if(!req.user||req.user.id!==req.studySet.owner_id)return fail(res,403,'Bạn không có quyền sửa bộ học này.');
  next();
}
const questionOf = row => ({
  id:row.id,position:row.position,prompt:row.prompt,
  options:JSON.parse(row.options_json),answers:JSON.parse(row.answers_json),
  verified:!!row.verified,explanation:row.explanation,topic:row.topic,source:row.source
});
async function publicSet(s,withQs=false) {
  const count=await one('SELECT COUNT(*)::int AS c FROM questions WHERE set_id=$1',[s.id]);
  const result={id:s.id,title:s.title,description:s.description,subject:s.subject,
    visibility:s.visibility,owner_name:s.owner_name,created_at:s.created_at,updated_at:s.updated_at,count:count.c};
  if(withQs)result.questions=(await q('SELECT * FROM questions WHERE set_id=$1 ORDER BY position,id',[s.id])).rows.map(questionOf);
  return result;
}
function normalizeQuestion(item,index,existingIds) {
  const prompt=String(item.prompt||'').trim();
  let options=Array.isArray(item.options)?item.options:[];
  options=options.map(o=>typeof o==='string'?{id:uuid(),text:o}:{id:String(o.id||uuid()),text:String(o.text||'')}).filter(o=>o.text.trim());
  const ids=new Set(options.map(o=>o.id));
  const answers=Array.isArray(item.answers)?item.answers.filter(a=>ids.has(a)):[];
  if(!prompt||options.length<2||options.length>8)throw Error(`Câu ${index+1} phải có nội dung và 2–8 lựa chọn.`);
  if(ids.size!==options.length)throw Error(`Câu ${index+1} có ID đáp án trùng nhau.`);
  const oldId=String(item.id||'');
  return {id:existingIds.has(oldId)?oldId:uuid(), position:index+1,prompt,options,answers,
    verified:!!item.verified&&answers.length>0,explanation:String(item.explanation||''),
    topic:String(item.topic||''),source:String(item.source||'')};
}
async function saveQuestions(id,questions) {
  if(!Array.isArray(questions)||!questions.length||questions.length>3000)throw Error('Danh sách phải có từ 1 đến 3000 câu. Không cho lưu trống để tránh xóa nhầm.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM sets WHERE id=$1 FOR UPDATE',[id]);
    const previous=(await client.query('SELECT * FROM questions WHERE set_id=$1 ORDER BY position,id',[id])).rows.map(questionOf);
    const previousIds=new Set(previous.map(x=>x.id));
    const normalized=questions.map((item,index)=>normalizeQuestion(item,index,previousIds));
    if(new Set(normalized.map(x=>x.id)).size!==normalized.length)throw Error('Danh sách câu hỏi chứa ID trùng nhau.');
    if(previous.length) {
      await client.query('INSERT INTO question_revisions(revision_id,set_id,saved_at,questions_json) VALUES($1,$2,$3,$4)',
        [uuid(),id,now(),JSON.stringify(previous)]);
    }
    await client.query('DELETE FROM questions WHERE set_id=$1',[id]);
    for(const item of normalized) {
      await client.query(`INSERT INTO questions(id,set_id,position,prompt,options_json,answers_json,verified,explanation,topic,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [item.id,id,item.position,item.prompt,JSON.stringify(item.options),JSON.stringify(item.answers),item.verified?1:0,item.explanation,item.topic,item.source]);
    }
    await client.query('UPDATE sets SET updated_at=$1 WHERE id=$2',[now(),id]);
    await client.query('COMMIT');
    return normalized.length;
  } catch(err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
const hashPassword=(password,salt)=>crypto.scryptSync(password,salt,64).toString('hex');
async function signin(req,res,email,password) {
  const u=await one('SELECT * FROM users WHERE email=$1',[email]);
  if(!u)return fail(res,401,'Thông tin đăng nhập không đúng.');
  const [salt,expected]=u.hash.split(':');
  const actual=hashPassword(password,salt);
  if(!crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex')))
    return fail(res,401,'Thông tin đăng nhập không đúng.');
  const token=crypto.randomBytes(32).toString('hex'),days=30;
  await q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [crypto.createHash('sha256').update(token).digest('hex'),u.id,Date.now()+days*86400000]);
  res.setHeader('Set-Cookie',`studyhub_session=${token}; Max-Age=${days*86400}; ${cookieOpts}`);
  res.json({user:{id:u.id,name:u.name,email:u.email}});
}
app.post('/api/auth/register',wrapped(async(req,res)=>{
  let {email,password,name}=req.body||{};
  email=String(email||'').toLowerCase().trim();name=String(name||'').trim();
  if(!/^\S+@\S+\.\S+$/.test(email)||!name||String(password||'').length<8)
    return fail(res,400,'Vui lòng nhập tên, email hợp lệ và mật khẩu ít nhất 8 ký tự.');
  const salt=crypto.randomBytes(16).toString('hex');
  try { await q('INSERT INTO users(id,email,name,hash,created_at) VALUES($1,$2,$3,$4,$5)',
    [uuid(),email,name,salt+':'+hashPassword(password,salt),now()]); }
  catch(err) { if(err.code==='23505')return fail(res,409,'Email này đã được sử dụng.');throw err; }
  return signin(req,res,email,password);
}));
app.post('/api/auth/login',wrapped((req,res)=>signin(req,res,String(req.body?.email||'').toLowerCase().trim(),String(req.body?.password||''))));
app.post('/api/auth/logout',wrapped(async(req,res)=>{
  const token=readCookies(req).studyhub_session;
  if(token)await q('DELETE FROM sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]);
  res.setHeader('Set-Cookie',`studyhub_session=; Max-Age=0; ${cookieOpts}`);
  res.json({ok:true});
}));
app.get('/api/me',wrapped(async(req,res)=>res.json({user:await me(req)})));
app.get('/api/sets',wrapped(async(req,res)=>{
  const u=await me(req),keyword=`%${String(req.query.q||'').slice(0,80)}%`;
  const rows=(await q(`SELECT sets.*,users.name AS owner_name FROM sets JOIN users ON users.id=sets.owner_id
    WHERE (visibility='public' OR owner_id=$1) AND (title ILIKE $2 OR subject ILIKE $3)
    ORDER BY updated_at DESC LIMIT 100`,[u?.id||'',keyword,keyword])).rows;
  res.json({sets:await Promise.all(rows.map(s=>publicSet(s)))});
}));
app.get('/api/sets/:id',wrapped(async(req,res)=>{
  const s=await getSet(req.params.id),u=await me(req);
  if(!s)return fail(res,404,'Không tìm thấy bộ học.');
  if(!canRead(s,u))return fail(res,403,'Bộ học riêng tư.');
  res.json({set:await publicSet(s,true),isOwner:!!u&&u.id===s.owner_id});
}));
app.post('/api/sets',wrapped(async(req,res)=>{
  await auth(req,res,()=>{});if(!req.user)return;
  const title=String(req.body?.title||'').trim().slice(0,160);
  if(!title)return fail(res,400,'Nhập tên bộ học.');
  const id=uuid(),t=now();
  await q(`INSERT INTO sets(id,owner_id,title,description,subject,visibility,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,req.user.id,title,String(req.body.description||'').slice(0,2000),String(req.body.subject||'').slice(0,100),'private',t,t]);
  res.status(201).json({set:await publicSet(await getSet(id),true)});
}));
app.put('/api/sets/:id',wrapped(async(req,res)=>{
  await owner(req,res,()=>{});if(!req.studySet||!req.user||req.user.id!==req.studySet.owner_id)return;
  const title=String(req.body?.title||'').trim().slice(0,160),visibility=String(req.body?.visibility||'private');
  if(!title||!['private','unlisted','public'].includes(visibility))return fail(res,400,'Dữ liệu không hợp lệ.');
  await q('UPDATE sets SET title=$1,description=$2,subject=$3,visibility=$4,updated_at=$5 WHERE id=$6',
    [title,String(req.body.description||'').slice(0,2000),String(req.body.subject||'').slice(0,100),visibility,now(),req.params.id]);
  res.json({set:await publicSet(await getSet(req.params.id),true)});
}));
app.put('/api/sets/:id/questions',wrapped(async(req,res)=>{
  await owner(req,res,()=>{});if(!req.studySet||!req.user||req.user.id!==req.studySet.owner_id)return;
  try { const count=await saveQuestions(req.params.id,req.body?.questions);
    res.json({count,set:await publicSet(await getSet(req.params.id),true)}); }
  catch(err) { if(/Danh sách|Câu |ID /.test(err.message))return fail(res,400,err.message);throw err; }
}));
app.delete('/api/sets/:id',wrapped(async(req,res)=>{
  await owner(req,res,()=>{});if(!req.studySet||!req.user||req.user.id!==req.studySet.owner_id)return;
  await q('DELETE FROM sets WHERE id=$1',[req.params.id]);res.json({ok:true});
}));
app.get('/api/sets/:id/progress',wrapped(async(req,res)=>{
  await auth(req,res,()=>{});if(!req.user)return;
  const s=await getSet(req.params.id);if(!canRead(s,req.user))return fail(res,403,'Không có quyền truy cập.');
  const row=await one('SELECT data_json FROM progress WHERE user_id=$1 AND set_id=$2',[req.user.id,req.params.id]);
  res.json({progress:row?JSON.parse(row.data_json):null});
}));
app.put('/api/sets/:id/progress',wrapped(async(req,res)=>{
  await auth(req,res,()=>{});if(!req.user)return;
  const s=await getSet(req.params.id);if(!canRead(s,req.user))return fail(res,403,'Không có quyền truy cập.');
  const data=req.body?.progress;
  if(!data||JSON.stringify(data).length>300000)return fail(res,400,'Tiến độ không hợp lệ.');
  await q(`INSERT INTO progress(user_id,set_id,data_json,updated_at) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,set_id) DO UPDATE SET data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at`,
    [req.user.id,req.params.id,JSON.stringify(data),now()]);
  res.json({ok:true});
}));
// Owner-only history endpoint; snapshots are kept in Neon, not Render's temporary disk.
app.get('/api/sets/:id/revisions',wrapped(async(req,res)=>{
  await owner(req,res,()=>{});if(!req.studySet||!req.user||req.user.id!==req.studySet.owner_id)return;
  const rows=(await q(`SELECT revision_id,saved_at,questions_json FROM question_revisions
    WHERE set_id=$1 ORDER BY saved_at DESC LIMIT 100`,[req.params.id])).rows;
  res.json({revisions:rows.map(r=>({revision_id:r.revision_id,saved_at:r.saved_at,count:JSON.parse(r.questions_json).length}))});
}));
app.post('/api/sets/:id/revisions/:revisionId/restore',wrapped(async(req,res)=>{
  await owner(req,res,()=>{});if(!req.studySet||!req.user||req.user.id!==req.studySet.owner_id)return;
  const rev=await one('SELECT questions_json FROM question_revisions WHERE set_id=$1 AND revision_id=$2',
    [req.params.id,req.params.revisionId]);
  if(!rev)return fail(res,404,'Không tìm thấy bản lưu trước.');
  const count=await saveQuestions(req.params.id,JSON.parse(rev.questions_json));
  res.json({count,set:await publicSet(await getSet(req.params.id),true)});
}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024}});
async function extract(buffer,name) {
  const ext=path.extname(name).toLowerCase();
  if(['.txt','.csv','.json','.md'].includes(ext))return buffer.toString('utf8');
  if(ext==='.docx')return (await mammoth.extractRawText({buffer})).value;
  if(ext==='.pdf')return (await pdf(buffer)).text;
  if(['.xlsx','.xls'].includes(ext)){
    const wb=XLSX.read(buffer,{type:'buffer'});
    return wb.SheetNames.map(n=>XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  }
  if(ext==='.pptx'){
    const zip=new AdmZip(buffer);
    return zip.getEntries().filter(e=>/^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a,b)=>Number(a.entryName.match(/\d+/)[0])-Number(b.entryName.match(/\d+/)[0]))
      .map(e=>e.getData().toString().replace(/<a:p[^>]*>/g,'\n').replace(/<[^>]+>/g,' ')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')).join('\n');
  }
  throw Error('Chỉ hỗ trợ TXT, CSV, JSON, DOCX, PDF, PPTX và XLSX.');
}
app.post('/api/extract',wrapped(auth),upload.single('file'),wrapped(async(req,res)=>{
  if(!req.file)return fail(res,400,'Chưa chọn file.');
  try { let content=await extract(req.file.buffer,req.file.originalname);
    if(content.length>800000)content=content.slice(0,800000);
    res.json({text:content,filename:req.file.originalname,
      warning:'PDF dạng ảnh scan hoặc ký hiệu định dạng đặc biệt có thể trích xuất không đầy đủ. Vui lòng kiểm tra bản xem trước.'});
  } catch(err) { return fail(res,400,`Không đọc được file: ${err.message}`); }
}));
app.get('/health',wrapped(async(req,res)=>{
  await q('SELECT 1');res.json({ok:true,storage:'postgresql'});
}));
app.get('/study/:id',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError)return fail(res,400,'File vượt quá 12 MB.');
  console.error(err);
  fail(res,500,'Đã xảy ra lỗi máy chủ.');
});
const PORT=Number(process.env.PORT||3000);
init().then(()=>app.listen(PORT,()=>console.log(`StudyHub PostgreSQL ready on port ${PORT}`)))
  .catch(err=>{console.error('Database initialization failed:',err.message);process.exit(1);});
