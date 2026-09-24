
import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Project } from '../models/project.js';
import { Task } from '../models/task.js';

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(env.MONGODB_URI);
  console.log('Connected!');
  
  const project = await Project.findOne({ name: /vybe/i });
  if (!project) {
    console.log('Project not found');
    process.exit(1);
  }
  
  console.log('Found project:', project.name);
  const res = await Task.deleteMany({ project: project._id });
  console.log('Deleted ' + res.deletedCount + ' tasks for project ' + project.name);
  process.exit(0);
}
run().catch(console.error);

