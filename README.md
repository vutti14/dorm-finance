# Dorm Finance — ระบบเงินหอพัก นารา–ปรายดาว

ระบบบิลค่าห้องและเงินของหอพัก 2 แห่งในพิษณุโลก ใช้แทนสมุดมือและใบสำคัญจ่ายกระดาษ ทีม 6 บทบาททำงานพร้อมกันได้จากมือถือของแต่ละคน
และเห็นการเปลี่ยนแปลงของกันและกันภายในไม่กี่วินาที สเปกเต็มอยู่ใน `SPEC.md` (เก็บไว้นอก git จนกว่า repo จะเป็น Private)

**สถานะ: M1 (บิลค่าห้อง) + M2 (ใบเบิก อนุมัติ จ่าย ตรวจ เงินเดือน โอน/เจ้าของ กระทบยอด)** — ผลทดสอบและคำถามใน [docs/M1-report.md](docs/M1-report.md) · [docs/M2-report.md](docs/M2-report.md)

| | |
|---|---|
| หน้าเว็บ | React 18 + Vite + TypeScript + Tailwind เป็น PWA ติดตั้งบนมือถือได้ (`/app`) |
| ฐานข้อมูล | Supabase Postgres + RLS + RPC แบบ security definer (`/supabase/migrations`) |
| ล็อกอิน | เบอร์โทร + PIN 6 หลัก ผ่าน edge functions (`/supabase/functions`) |
| โฮสต์ | Cloudflare Pages (static) ใช้ Supabase Free ได้ |

## รันบนเครื่อง

```bash
# 1) ฐานข้อมูล (ต้องมี Docker + Supabase CLI)
supabase start                      # ใช้ migrations + config.toml ใน /supabase
supabase functions serve            # login / activate / admin-create-user

# 2) ยอดยกมาและประวัติสมุด ม.ค.–ก.ย. (ทำครั้งเดียว ต้องมี /reference)
cd scripts && npm install && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx tsx import-opening.ts

# 3) หน้าเว็บ
cd app && cp .env.example .env      # ใส่ URL + anon key จาก `supabase status`
npm install && npm run dev
```

บัญชีแรก (CEO) ต้องสร้างผ่าน SQL ครั้งเดียว ดูวิธีใน [docs/deploy.md](docs/deploy.md) จากนั้นสร้างบัญชีอื่นในแท็บ **ผู้ใช้งาน**

## ทดสอบ

```bash
cd app
npm test                 # importer + การคำนวณบิล (ใช้ reference/test_import_sample.xlsx)
npm run test:db          # Postgres จริงแบบใช้แล้วทิ้ง (ฐานข้อมูลใหม่ต่อไฟล์): migrations + RLS + RPC + กดพร้อมกัน
npm run typecheck && npm run build
```

`scripts/test-db.sh` ใช้ Postgres 15/16 ธรรมดา ไม่ต้องใช้ Docker โดยจำลองส่วน `auth` ของ Supabase จาก `supabase/tests/stubs.sql`

## โครงสร้าง

```
app/                    หน้าเว็บ (views = แท็บตาม prototype, lib = importer / billing / billText)
supabase/migrations/    schema · security (RLS, audit, ledger ห้ามแก้) · billing RPC · admin/ผู้เช่า/แจ้งเตือน · seed · storage · money (M2)
supabase/functions/     login · activate · admin-create-user
scripts/                import-opening.ts (ยอดยกมา + ประวัติสมุด) · test-db.sh
reference/              ไฟล์จากเจ้าของ (prototype, แบบฟอร์ม Excel, CSV) — ไม่อยู่ใน git จนกว่า repo จะเป็น Private
```

## กฎที่ห้ามละเมิด

- ห้ามใส่ service-role key ในหน้าเว็บหรือใน repo ใช้แค่ `.env.example`
- ห้ามเก็บรูปเป็น base64 ในตารางหรือ localStorage ให้เก็บใน Storage bucket `photos` แบบ private
- ทุกการเปลี่ยนสถานะเงินต้องผ่าน RPC ที่ตรวจสิทธิ์และล็อกแถว ส่วนหน้าเว็บอ่านข้อมูลได้อย่างเดียว
- ตาราง `ledger_entries` แก้หรือลบไม่ได้ ถ้าผิดให้บันทึกรายการกลับรายการแทน
