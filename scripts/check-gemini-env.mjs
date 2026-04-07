/**
 * 키 값은 출력하지 않고, .env 로드 여부만 확인합니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Downloads 안에 이름만 비슷하고 경로가 다른 복사본(공백 많은 폴더)에서 자주 혼동됨
const suspiciousPath =
  /짐\s+구\s+공/.test(projectRoot) ||
  /상\s+담/.test(projectRoot) ||
  /관\s+리/.test(projectRoot) ||
  /시\s+스\s+템/.test(projectRoot);
if (suspiciousPath) {
  console.error('');
  console.error('⚠️  이 프로젝트 폴더 이름에 한글 사이 공백이 많습니다.');
  console.error('   Cursor/작업용으로는 보통 아래처럼 공백 없는 폴더 하나만 쓰는 것이 안전합니다.');
  console.error('   예: …/Downloads/짐구공-fc-상담-관리-시스템');
  console.error('');
}

const envPath = path.join(projectRoot, '.env');
const envLocalPath = path.join(projectRoot, '.env.local');
const envExists = fs.existsSync(envPath);
const envLocalExists = fs.existsSync(envLocalPath);

dotenv.config({ path: envPath, quiet: true });
dotenv.config({ path: envLocalPath, override: true, quiet: true });

const fromShell = (
  process.env.GEMINI_API_KEY ||
  process.env.VITE_GEMINI_API_KEY ||
  ''
).trim();

const isPlaceholder =
  !fromShell ||
  /^MY_GEMINI_API_KEY$/i.test(fromShell) ||
  fromShell === 'your_api_key_here' ||
  fromShell.length < 20;

if (fromShell && !isPlaceholder) {
  console.log(
    `OK: GEMINI_API_KEY가 설정되어 있습니다 (길이 ${fromShell.length}자, 내용은 표시하지 않음).`
  );
  console.log('다음: npm run dev 를 다시 켠 뒤 앱에서 「AI 문구 생성하기」로 최종 확인하세요.');
  process.exit(0);
}

console.error('실패: GEMINI_API_KEY / VITE_GEMINI_API_KEY 가 없거나 유효하지 않습니다.');
if (!envExists && !envLocalExists) {
  console.error('');
  console.error('→ 이 폴더에 .env / .env.local 파일이 없습니다. 아래를 터미널에서 실행하세요:');
  console.error(`   cd "${projectRoot}"`);
  console.error('   cp .env.example .env');
  console.error('   그 다음 .env 를 열어 GEMINI_API_KEY= 뒤에 발급받은 키를 붙여넣고 저장하세요.');
  console.error('   (MY_GEMINI_API_KEY 그대로 두면 안 됩니다.)');
} else {
  console.error(`확인할 파일: ${envPath}${envLocalExists ? ` 또는 ${envLocalPath}` : ''}`);
  if (isPlaceholder && fromShell) {
    console.error('→ 값이 플레이스홀더이거나 너무 짧습니다. AI Studio에서 발급한 실제 키(AIza…)로 바꾸세요.');
  }
}
console.error('');
console.error('키 발급: https://aistudio.google.com/apikey');
process.exit(1);
