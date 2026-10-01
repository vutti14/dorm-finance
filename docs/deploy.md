# Deploy (Supabase + Cloudflare Pages)

## 1. Supabase (สร้าง project ชื่อ `dorm-finance`, region Singapore)

1. **Auth → Providers → Email**: เปิด Email, ปิด "Confirm email"
2. **Auth → Settings**: ปิด "Allow new users to sign up" และตั้ง password ขั้นต่ำ 6 ตัว
3. ติดตั้ง Supabase CLI แล้วรัน:
   ```bash
   supabase link --project-ref <ref>
   supabase db push                                   # migrations ทั้งหมด
   supabase functions deploy login --no-verify-jwt
   supabase functions deploy activate --no-verify-jwt
   supabase functions deploy admin-create-user
   supabase functions deploy read-meter               # M4: AI อ่านเลขมิเตอร์จากรูป (ไม่ deploy ก็ได้ — พิมพ์เลขเองได้ตามปกติ)
   ```
4. โหลดยอดยกมาและประวัติสมุด (ครั้งเดียว ใช้ connection string จาก Project settings → Database):
   `cd scripts && npm install && DATABASE_URL='postgresql://…' npx tsx import-opening.ts`
5. **บัญชีแรก (CEO)**: Auth → Users → Add user → email `p<เบอร์>@dorm.internal`, ตั้งรหัสชั่วคราว, ติ๊ก Auto confirm
   แล้วรันใน SQL editor:
   ```sql
   insert into profiles (id, display_name, phone, role)
   select id, 'อาร์ต', '<เบอร์ 10 หลัก>', 'ceo' from auth.users where email = 'p<เบอร์>@dorm.internal';
   ```
   จากนั้นเข้าแอป → แท็บผู้ใช้งาน → "ออกรหัสใหม่" ให้ตัวเอง เพื่อตั้ง PIN ผ่านหน้า "ครั้งแรก หรือ ลืม PIN"
6. **AI อ่านมิเตอร์ (ไม่บังคับ)**: สร้าง API key ที่ console.anthropic.com แล้วตั้งเป็น secret ของ function เอง
   ด้วยคำสั่ง `supabase secrets set ANTHROPIC_API_KEY=…` (พิมพ์ในเครื่องตัวเองเท่านั้น ห้ามวางในแชท/ไฟล์/หน้าเว็บ)
   ถ้าอยากใช้โมเดลอื่นตั้ง `METER_AI_MODEL` ได้ (ค่าเริ่มต้น claude-opus-5-5) · ถ้ายังไม่ตั้ง key ปุ่มถ่ายรูปยังใช้ได้ แค่ AI ไม่อ่านให้
7. ห้ามวาง service-role key ในแชทหรือในไฟล์ที่ commit เด็ดขาด เพราะ edge functions อ่านค่านี้จาก environment ของ Supabase เองอยู่แล้ว

## 2. Cloudflare Pages

- Connect GitHub → repo `dorm-finance`
- Build command `npm ci && npm run build` · Build output `dist` · Root directory `app`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (ใช้แค่ anon key)
- ไม่ต้องตั้ง `_redirects` เพิ่ม: Pages จะส่ง `index.html` ให้ทุก path ที่ไม่มีไฟล์ตรงอยู่แล้ว ซึ่งรวมถึงลิงก์ลงทะเบียน `/r/<token>`
- เพิ่ม URL ของ Pages ใน Supabase **Auth → URL configuration → Site URL**
