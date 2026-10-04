# ขึ้นระบบจริง (Supabase + Cloudflare Pages)

ทั้งหมดประมาณ 30–45 นาที ทำจากคอมพิวเตอร์ (บางขั้นทำบนมือถือได้) · **ห้ามวางรหัส/คีย์ใด ๆ ในแชท** — ใส่เฉพาะในหน้าตั้งค่าของ Supabase / GitHub / Cloudflare เท่านั้น

## 0. ก่อนเริ่ม: เปลี่ยน repo เป็น Private

GitHub → `vutti14/dorm-finance` → Settings → General → Danger Zone → **Change visibility → Private**
(ต้องทำก่อน เพราะไฟล์ยอดยกมา/ประวัติสมุดมีชื่อคนและยอดเงินจริง) — เสร็จแล้วบอก Claude ให้ commit โฟลเดอร์ `reference/` เข้า repo

## 1. สร้าง Supabase project

1. supabase.com → New project · ชื่อ `dorm-finance` · Region **Southeast Asia (Singapore)** · ตั้ง Database password (เก็บในที่ปลอดภัย)
2. **Authentication → Sign In / Providers → Email**: เปิด Email · **ปิด "Confirm email"**
3. **Authentication → Sign In / Providers**: **ปิด "Allow new users to sign up"** (บัญชีสร้างผ่านแท็บผู้ใช้งานเท่านั้น) · Password minimum length = 6

## 2. ใส่ secret ใน GitHub (ครั้งเดียว)

GitHub → repo → Settings → Secrets and variables → **Actions → New repository secret** ใส่ 3–4 ตัวนี้

| ชื่อ | เอามาจาก |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → รูปโปรไฟล์ → Account preferences → **Access Tokens** → Generate new token |
| `SUPABASE_PROJECT_REF` | รหัสใน URL ของ project: `supabase.com/dashboard/project/`**`abcdxyz…`** |
| `SUPABASE_DB_URL` | project → ปุ่ม **Connect** → แบบ **Session pooler** → คัดลอก แล้วแทน `[YOUR-PASSWORD]` ด้วย Database password |
| `ANTHROPIC_API_KEY` | (ไม่บังคับ) console.anthropic.com → API Keys — เปิดให้ AI อ่านเลขมิเตอร์ |

ใช้ **Session pooler** เท่านั้น (แบบ Direct connection ใช้จาก GitHub ไม่ได้)

## 3. กดขึ้นระบบ

GitHub → repo → **Actions → deploy → Run workflow** (เลือก branch ที่จะขึ้นระบบ)
- ช่อง **"ทดลองใช้ทุกฟังก์ชันแล้วลบข้อมูลทดสอบ"** ติ๊กไว้ให้แล้ว: ระบบสร้างบัญชีทดสอบ (เบอร์ 09900000xx) แล้วลองทุกอย่างผ่านระบบจริง — ล็อกอิน/ตั้ง PIN, นำเข้า Excel, จดมิเตอร์พร้อมรูป, AI อ่านเลข, วางบิล, รับเงิน, ยกยอดค้าง, ใบเบิก/อนุมัติ/จ่าย/ตรวจ, ช่างลงเวลา, รายได้/รายจ่ายอื่น, รายงาน NOI, การอัปเดตข้ามเครื่อง — **แล้วลบเฉพาะข้อมูลทดสอบทิ้งทั้งหมด** ผลขึ้นในหน้าสรุปของ Actions (ใช้ได้เฉพาะ project ใหม่ที่ยังไม่มีข้อมูลจริง ถ้ามีข้อมูลแล้วระบบจะไม่ยอมรัน)
- ครั้งแรก ติ๊ก **"โหลดยอดยกมา + ประวัติ ม.ค.–ก.ย."** (ต้องทำข้อ 0 และ commit `reference/` แล้ว — ถ้ายังเป็น public ระบบจะไม่ยอมโหลด)
- ระบบจะ: สร้างตารางทั้งหมด (migrations) → ติดตั้ง login / activate / admin-create-user / read-meter → ตั้งคีย์ AI → โหลดยอดยกมา
- กดซ้ำได้ทุกครั้งที่มีเวอร์ชันใหม่ (ไม่โหลดข้อมูลซ้ำ ไม่ลบข้อมูลเดิม)

## 4. Cloudflare Pages (หน้าเว็บ)

1. dash.cloudflare.com → Workers & Pages → Create → **Pages → Connect to Git** → เลือก `dorm-finance`
2. Production branch: `main` (หรือ branch ที่จะใช้) · Root directory **`app`** · Build command **`npm ci && npm run build`** · Build output **`dist`**
3. Environment variables:
   - `VITE_SUPABASE_URL` = Supabase → Project Settings → Data API → **Project URL**
   - `VITE_SUPABASE_ANON_KEY` = Project Settings → API Keys → **anon / publishable** (ห้ามใช้ service_role)
4. Deploy → ได้ลิงก์ `https://dorm-finance-xxx.pages.dev` (ผูกโดเมนของตัวเองภายหลังได้)
5. Supabase → Authentication → URL Configuration → **Site URL** = ลิงก์ Pages

## 5. บัญชีแรก (CEO)

1. Supabase → Authentication → Users → **Add user → Create new user**
   - Email: `p<เบอร์ 10 หลัก>@dorm.internal` เช่น `p0812345678@dorm.internal`
   - Password: **PIN 6 หลัก** ที่จะใช้เข้าแอป · ติ๊ก **Auto Confirm User**
2. Supabase → SQL Editor → รัน (แก้ชื่อ/เบอร์):
   ```sql
   insert into profiles (id, display_name, phone, role)
   select id, 'อาร์ต', '0812345678', 'ceo' from auth.users where email = 'p0812345678@dorm.internal';
   ```
3. เปิดลิงก์ Pages → เข้าด้วยเบอร์ + PIN → แท็บ **ผู้ใช้งาน** → สร้างบัญชีให้ เป้อ · นุ้ย · กวาง · หน่อย · ช่าง (ระบบออกรหัสเปิดใช้ 8 หลัก ให้แต่ละคนไปตั้ง PIN เอง)
4. แท็บ **ตั้งค่า** (กวาง/CEO): ตรวจอัตราค่าไฟ/น้ำ ชื่อบัญชีรับโอน เพดานรายจ่ายอื่น (3,000) และใส่ยอดยกมาเงินสำรองนุ้ย

## 6. ตรวจหลังขึ้นระบบ (ทำครั้งแรก)

- เปิดแอป 2 เครื่องพร้อมกัน (เช่น เป้อกับกวาง) → เครื่องหนึ่งบันทึกรับเงิน อีกเครื่องต้องเห็นภายในไม่กี่วินาทีโดยไม่ต้องรีเฟรช (SPEC §10 ข้อ 2)
- จดมิเตอร์ 1 ห้องด้วยรูปจริง → AI ต้องอ่านเลขให้ (ถ้าตั้ง `ANTHROPIC_API_KEY`)
- นำเข้าแบบฟอร์ม Excel รอบ พ.ย. หรือกด "เริ่มรอบบิล" ในแท็บจดมิเตอร์

## กฎความปลอดภัย

- service_role key / Database password / Access token / API key: ใส่เฉพาะในหน้าตั้งค่าของระบบนั้น ๆ หรือ GitHub Secrets — **ไม่วางในแชท ไม่ใส่ในไฟล์ ไม่ใส่ในหน้าเว็บ**
- หน้าเว็บใช้แค่ anon key (ปลอดภัยเพราะทุกตารางมี RLS และทุกการเปลี่ยนเงินผ่าน RPC ที่ตรวจสิทธิ์)
- ถ้าคีย์หลุด: Supabase → Project Settings → API Keys → rotate แล้วอัปเดต secret ใน GitHub / Cloudflare

## ทำเองด้วย CLI (ทางเลือก แทนข้อ 2–3)

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy login --no-verify-jwt
supabase functions deploy activate --no-verify-jwt
supabase functions deploy admin-create-user
supabase functions deploy read-meter
supabase secrets set ANTHROPIC_API_KEY=…        # พิมพ์ในเครื่องตัวเองเท่านั้น
cd scripts && npm ci && DATABASE_URL='<session pooler url>' npx tsx import-opening.ts
```
