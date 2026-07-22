// e2e 测试前加载 apps/api/.env（DATABASE_URL 等）
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.WX_MODE = process.env.WX_MODE || 'mock';
process.env.PAY_MODE = process.env.PAY_MODE || 'mock';
process.env.ALLOW_MOCK_PAYMENTS = process.env.ALLOW_MOCK_PAYMENTS || 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
