import { getTopCrdsFromZset } from './_lib';
export default async function handler(req: any, res: any) {
  const i = await getTopCrdsFromZset('individual', 2);
  const f = await getTopCrdsFromZset('firm', 2);
  res.status(200).json({ i, f });
}
