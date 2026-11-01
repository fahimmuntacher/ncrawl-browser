import { startMockErp } from './server.ts';

const erp = await startMockErp({ port: Number(process.env.MOCK_ERP_PORT ?? 4600) });
console.log(`Mock ERP running at ${erp.url}  (login: demo / demo)`);
const stop = () => void erp.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
