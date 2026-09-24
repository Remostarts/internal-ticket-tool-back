import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Project } from '../models/project.js';
import { Task } from '../models/task.js';
import { User } from '../models/user.js';

async function importRoadmap() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const admin = await User.findOne({ role: 'admin' });
  const creatorId = admin ? admin._id : new mongoose.Types.ObjectId();
  console.log(`Using creator ID: ${creatorId} (${admin?.username || 'system'})`);

  const project = await Project.findOne({ name: /vybe/i });
  if (!project) {
    console.error('Vybe Bank project not found in database!');
    process.exit(1);
  }
  console.log(`Found target project: "${project.name}" (ID: ${project._id})`);

  // 1. Delete all existing tasks for Vybe Bank
  const deleteResult = await Task.deleteMany({ project: project._id });
  console.log(`Cleared ${deleteResult.deletedCount} old tasks from project.`);

  // 2. Read roadmap markdown file
  const roadmapPath = path.resolve(process.cwd(), '../Project Phased Development Roadmap.md');
  console.log(`Reading roadmap from: ${roadmapPath}`);
  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  let currentPhase = 'Phase 1: Foundation & Core Infrastructure';
  const tasksToInsert: any[] = [];
  let position = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check for Phase headers
    if (line.startsWith('#')) {
      const cleanHeader = line.replace(/^[#\s*]+|[#\s*]+$/g, '').trim();
      if (cleanHeader) {
        currentPhase = cleanHeader;
      }
      continue;
    }

    // Match feature list item: * **Title**: Description
    const match = line.match(/^\*\s*\*\*(.+?)\*\*:\s*(.+)$/);
    if (match && match[1] && match[2]) {
      const title = match[1].trim();
      const featureDesc = match[2].trim();

      tasksToInsert.push({
        project: project._id,
        creator: creatorId,
        title,
        description: `[${currentPhase}]\n\n${featureDesc}`,
        priority: 'P2',
        column: 'backlog',
        position: position++,
        type: 'feature',
        featureChecklist: {
          figma: false,
          development: false,
          testing: false,
          deployed: false,
        },
        visibleOnBoard: true,
        isPersonal: false,
      });
    }
  }

  console.log(`Parsed ${tasksToInsert.length} feature tasks from roadmap.`);

  if (tasksToInsert.length > 0) {
    const inserted = await Task.insertMany(tasksToInsert);
    console.log(`Successfully imported ${inserted.length} tasks into backlog!`);
    const firstTask = inserted[0];
    if (firstTask) {
      console.log('Sample task created:', {
        id: firstTask._id,
        title: firstTask.title,
        description: firstTask.description,
        column: firstTask.column,
        checklist: firstTask.featureChecklist,
      });
    }
  }

  await mongoose.disconnect();
  console.log('Database disconnected. Import complete!');
  process.exit(0);
}

importRoadmap().catch((err) => {
  console.error('Error importing roadmap:', err);
  process.exit(1);
});
