'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {DatabaseSync} = require('node:sqlite');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

const app = express();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR,{recursive:true});
const db = new DatabaseSync(path.join(DATA_DIR,'studyhub.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',subject TEXT NOT NULL DEFAULT '',visibility TEXT NOT NULL DEFAULT 'private',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,set_id TEXT NOT NULL,position INTEGER NOT NULL,prompt TEXT NOT NULL,options_json TEXT NOT NULL,answers_json TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,explanation TEXT NOT NULL DEFAULT '',topic TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT '',FOREIGN KEY(set_id) REFERENCES sets(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_question_set ON questions(set_id,position);
CREATE TABLE IF NOT EXISTS progress(user_id TEXT NOT NULL,set_id TEXT NOT NULL,data_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,set_id),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(set_id) REFERENCES sets(id) ON DELETE CASCADE);
`);
const uuid = ()=>crypto.randomUUID();
const now = ()=>new Date().toISOString();
const cookieOpts = `Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV==='production'?'; Secure':''}`;
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
function fail(res,status,message){return res.status(status).json({error:message});}
function readCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i).trim(),v.slice(i+1).trim()]}));}
function me(req){let token=readCookies(req).studyhub_session;if(!token)return null;let hash=crypto.createHash('sha256').update(token).digest('hex');let user=db.prepare('SELECT users.id,users.email,users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hash,Date.now());return user||null;}
function auth(req,res,next){req.user=me(req);if(!req.user)return fail(res,401,'Vui lòng đăng nhập để tiếp tục.');next();}
function getSet(id){return db.prepare('SELECT sets.*,users.name AS owner_name FROM sets JOIN users ON users.id=sets.owner_id WHERE sets.id=?').get(id);}
function canRead(s,u){return !!s && (s.visibility!=='private'||(u&&u.id===s.owner_id));}
function owner(req,res,next){req.user=me(req);req.studySet=getSet(req.params.id);if(!req.studySet)return fail(res,404,'Không tìm thấy bộ học.');if(!req.user||req.user.id!==req.studySet.owner_id)return fail(res,403,'Bạn không có quyền sửa bộ học này.');next();}
function publicSet(s,withQs=false){let obj={id:s.id,title:s.title,description:s.description,subject:s.subject,visibility:s.visibility,owner_name:s.owner_name,created_at:s.created_at,updated_at:s.updated_at,count:db.prepare('SELECT COUNT(*) AS c FROM questions WHERE set_id=?').get(s.id).c};if(withQs){obj.questions=db.prepare('SELECT * FROM questions WHERE set_id=? ORDER BY position,id').all(s.id).map(q=>({id:q.id,position:q.position,prompt:q.prompt,options:JSON.parse(q.options_json),answers:JSON.parse(q.answers_json),verified:!!q.verified,explanation:q.explanation,topic:q.topic,source:q.source}));}return obj;}
function normalizeQuestion(q,index){const prompt=String(q.prompt||'').trim();let options=Array.isArray(q.options)?q.options:[];options=options.map(o=>typeof o==='string'?{id:uuid(),text:o}:({id:String(o.id||uuid()),text:String(o.text||'')})).filter(o=>o.text.trim());const ids=new Set(options.map(o=>o.id));let answers=Array.isArray(q.answers)?q.answers.filter(a=>ids.has(a)):[];if(!prompt||options.length<2||options.length>8)throw Error(`Câu ${index+1} phải có nội dung và 2–8 lựa chọn.`);if(ids.size!==options.length)throw Error(`Câu ${index+1} có ID đáp án trùng nhau.`);return {id:uuid(),position:index+1,prompt,options,answers,verified:!!q.verified&&answers.length>0,explanation:String(q.explanation||''),topic:String(q.topic||''),source:String(q.source||'')};}
const transactionSave=db.transaction?null:null;
function saveQuestions(id,questions){let normalized=questions.map(normalizeQuestion);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM questions WHERE set_id=?').run(id);let insert=db.prepare('INSERT INTO questions(id,set_id,position,prompt,options_json,answers_json,verified,explanation,topic,source) VALUES(?,?,?,?,?,?,?,?,?,?)');for(let q of normalized)insert.run(q.id,id,q.position,q.prompt,JSON.stringify(q.options),JSON.stringify(q.answers),q.verified?1:0,q.explanation,q.topic,q.source);db.prepare('UPDATE sets SET updated_at=? WHERE id=?').run(now(),id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return normalized.length;}
const hashPassword=(pw,salt)=>crypto.scryptSync(pw,salt,64).toString('hex');
app.post('/api/auth/register',(req,res)=>{let {email,password,name}=req.body||{};email=String(email||'').toLowerCase().trim();name=String(name||'').trim();if(!/^\S+@\S+\.\S+$/.test(email)||!name||String(password||'').length<8)return fail(res,400,'Vui lòng nhập tên, email hợp lệ và mật khẩu ít nhất 8 ký tự.');let salt=crypto.randomBytes(16).toString('hex');try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(uuid(),email,name,salt+':'+hashPassword(password,salt),now());return signin(req,res,email,password);}catch(e){return fail(res,409,'Email này đã được sử dụng.');}});
function signin(req,res,email,password){let u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u)return fail(res,401,'Thông tin đăng nhập không đúng.');let [salt,expected]=u.hash.split(':');let actual=hashPassword(password,salt);if(!crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex')))return fail(res,401,'Thông tin đăng nhập không đúng.');let token=crypto.randomBytes(32).toString('hex');let days=30;db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),u.id,Date.now()+days*86400000);res.setHeader('Set-Cookie',`studyhub_session=${token}; Max-Age=${days*86400}; ${cookieOpts}`);return res.json({user:{id:u.id,name:u.name,email:u.email}});}
app.post('/api/auth/login',(req,res)=>signin(req,res,String(req.body?.email||'').toLowerCase().trim(),String(req.body?.password||'')));
app.post('/api/auth/logout',(req,res)=>{let token=readCookies(req).studyhub_session;if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));res.setHeader('Set-Cookie',`studyhub_session=; Max-Age=0; ${cookieOpts}`);res.json({ok:true});});
app.get('/api/me',(req,res)=>res.json({user:me(req)}));
app.get('/api/sets',(req,res)=>{let u=me(req);let keyword=`%${String(req.query.q||'').slice(0,80)}%`;let rows=db.prepare(`SELECT sets.*,users.name AS owner_name FROM sets JOIN users ON users.id=sets.owner_id WHERE (visibility='public' OR owner_id=?) AND (title LIKE ? OR subject LIKE ?) ORDER BY updated_at DESC LIMIT 100`).all(u?.id||'',keyword,keyword);res.json({sets:rows.map(s=>publicSet(s))});});
app.get('/api/sets/:id',(req,res)=>{let s=getSet(req.params.id),u=me(req);if(!s)return fail(res,404,'Không tìm thấy bộ học.');if(!canRead(s,u))return fail(res,403,'Bộ học riêng tư.');res.json({set:publicSet(s,true),isOwner:!!u&&u.id===s.owner_id});});
app.post('/api/sets',auth,(req,res)=>{let title=String(req.body?.title||'').trim().slice(0,160);if(!title)return fail(res,400,'Nhập tên bộ học.');let id=uuid(),t=now();db.prepare('INSERT INTO sets VALUES(?,?,?,?,?,?,?,?)').run(id,req.user.id,title,String(req.body.description||'').slice(0,2000),String(req.body.subject||'').slice(0,100),'private',t,t);res.status(201).json({set:publicSet(getSet(id),true)});});
app.put('/api/sets/:id',owner,(req,res)=>{let title=String(req.body?.title||'').trim().slice(0,160),visibility=String(req.body?.visibility||'private');if(!title||!['private','unlisted','public'].includes(visibility))return fail(res,400,'Dữ liệu không hợp lệ.');db.prepare('UPDATE sets SET title=?,description=?,subject=?,visibility=?,updated_at=? WHERE id=?').run(title,String(req.body.description||'').slice(0,2000),String(req.body.subject||'').slice(0,100),visibility,now(),req.params.id);res.json({set:publicSet(getSet(req.params.id),true)});});
app.put('/api/sets/:id/questions',owner,(req,res)=>{try{let questions=req.body?.questions;if(!Array.isArray(questions)||questions.length>3000)return fail(res,400,'Số lượng câu không hợp lệ (tối đa 3000).');let count=saveQuestions(req.params.id,questions);res.json({count,set:publicSet(getSet(req.params.id),true)});}catch(e){return fail(res,400,e.message);}});
app.delete('/api/sets/:id',owner,(req,res)=>{db.prepare('DELETE FROM sets WHERE id=?').run(req.params.id);res.json({ok:true});});
app.get('/api/sets/:id/progress',auth,(req,res)=>{let s=getSet(req.params.id);if(!canRead(s,req.user))return fail(res,403,'Không có quyền truy cập.');let row=db.prepare('SELECT data_json FROM progress WHERE user_id=? AND set_id=?').get(req.user.id,req.params.id);res.json({progress:row?JSON.parse(row.data_json):null});});
app.put('/api/sets/:id/progress',auth,(req,res)=>{let s=getSet(req.params.id);if(!canRead(s,req.user))return fail(res,403,'Không có quyền truy cập.');let data=req.body?.progress;if(!data||JSON.stringify(data).length>300000)return fail(res,400,'Tiến độ không hợp lệ.');db.prepare('INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(user_id,set_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(req.user.id,req.params.id,JSON.stringify(data),now());res.json({ok:true});});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024}});
async function extract(buffer,name){let ext=path.extname(name).toLowerCase();if(['.txt','.csv','.json','.md'].includes(ext))return buffer.toString('utf8');if(ext==='.docx')return (await mammoth.extractRawText({buffer})).value;if(ext==='.pdf')return (await pdf(buffer)).text;if(['.xlsx','.xls'].includes(ext)){let wb=XLSX.read(buffer,{type:'buffer'});return wb.SheetNames.map(n=>XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');}if(ext==='.pptx'){let zip=new AdmZip(buffer);return zip.getEntries().filter(e=>/^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort((a,b)=>Number(a.entryName.match(/\d+/)[0])-Number(b.entryName.match(/\d+/)[0])).map(e=>e.getData().toString().replace(/<a:p[^>]*>/g,'\n').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')).join('\n');}throw Error('Chỉ hỗ trợ TXT, CSV, JSON, DOCX, PDF, PPTX và XLSX.');}
app.post('/api/extract',auth,upload.single('file'),async(req,res)=>{if(!req.file)return fail(res,400,'Chưa chọn file.');try{let content=await extract(req.file.buffer,req.file.originalname);if(content.length>800000)content=content.slice(0,800000);res.json({text:content,filename:req.file.originalname,warning:'PDF dạng ảnh scan hoặc ký hiệu định dạng đặc biệt có thể trích xuất không đầy đủ. Vui lòng kiểm tra bản xem trước.'});}catch(e){fail(res,400,`Không đọc được file: ${e.message}`);}});
app.get('/health',(req,res)=>res.json({ok:true}));
app.get('/study/:id',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError)return fail(res,400,'File vượt quá 12 MB.');console.error(err);fail(res,500,'Đã xảy ra lỗi máy chủ.');});
const PORT=Number(process.env.PORT||3000);
app.listen(PORT,()=>console.log(`StudyHub: http://localhost:${PORT}`));
