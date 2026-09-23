import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);
import { connectDatabase, disconnect } from '../db/connect.js';
import { User } from '../models/user.js';
import { env } from '../config/env.js';

async function run() {
  await connectDatabase(env.MONGODB_URI);

  const targets = [
    'client_182257@esame.test',
    'client_181930@esame.test',
    'agent_180539@claimdesk.test',
    'client_182257',
    'client_181930',
    'agent_180539',
  ];

  const found = await User.find({
    $or: [
      { email: { $in: targets } },
      { username: { $in: targets } },
    ],
  }).lean();

  console.log('Found users to remove:', found.map((u) => ({ id: u._id.toString(), email: u.email, username: u.username, name: u.profile?.fullName })));

  const res = await User.deleteMany({
    $or: [
      { email: { $in: targets } },
      { username: { $in: targets } },
    ],
  });

  console.log('Successfully deleted:', res.deletedCount);
  await disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
