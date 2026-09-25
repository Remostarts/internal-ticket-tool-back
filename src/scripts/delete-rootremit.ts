import { env } from '../config/env.js';
import { connectDatabase, disconnect } from '../db/connect.js';
import { logger } from '../logging/logger.js';
import { Project } from '../models/project.js';
import { User } from '../models/user.js';
import { Session } from '../models/session.js';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  
  const project = await Project.findOne({ slug: 'rootremit' });
  if (project) {
    await Project.deleteOne({ _id: project._id });
    logger.info(`Deleted project: ${project.name}`);
  } else {
    logger.info('Project rootremit not found');
  }

  const user = await User.findOne({ email: 'esame@rootremit.com' });
  if (user) {
    await Session.deleteMany({ user: user._id });
    await User.deleteOne({ _id: user._id });
    logger.info(`Deleted user: ${user.email} and their sessions`);
  } else {
    logger.info('User esame@rootremit.com not found');
  }

  await disconnect();
}

void main().catch(console.error);
