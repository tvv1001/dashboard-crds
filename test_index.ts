import { refreshSavedKeyIndexFromRedis } from './pages/api/_lib';
refreshSavedKeyIndexFromRedis().then(res => console.log('Length:', res.length)).catch(console.error);
