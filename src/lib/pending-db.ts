import { promises as fs } from "node:fs";
import { Db } from "./app-updater.ts";
const PENDING_DB_PATH = "./docs/pending-db.json";

export interface PendingTask {
  packageName: string;
  version: string;
  timestamp: string;
}

function nowIso(): string {
  return new Date().toISOString();
}
const db = new Db<PendingTask>(PENDING_DB_PATH);
export async function savePendingTask(task: PendingTask): Promise<void> {
  let tasks: PendingTask[] = [];
  try {
   
    tasks = await db.read();
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      process.stderr.write(
        `[${nowIso()}] WARN could not read ${PENDING_DB_PATH}: ${error.message}\n`,
      );
    }
  }

  // Add new task to the top
  tasks.unshift(task);

  try {
    await await db.write(tasks);
  } catch (error: any) {
    process.stderr.write(
      `[${nowIso()}] WARN could not write to ${PENDING_DB_PATH}: ${error.message}\n`,
    );
  }
}
export async function getTask(): Promise<PendingTask | null> {
    const tasks =  await getPendingTasks();
    const firstTask = tasks.length > 0 ? tasks[0] : null;
    if (firstTask){
       await removePendingTask(firstTask.packageName, firstTask.version);
    }
   
    return firstTask
}
export async function getPendingTasks(): Promise<PendingTask[]> {
    try {
        return await db.read();
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            console.error(`Error reading pending tasks db: ${error}`);
        }
        return [];
    }
}

export async function removePendingTask(packageName: string, version: string): Promise<void> {
    const tasks = await getPendingTasks();
    const updatedTasks = tasks.filter(task => !(task.packageName === packageName && task.version === version));

    try {
        await db.write(updatedTasks);
    } catch (error: any) {
        process.stderr.write(
            `[${nowIso()}] WARN could not write to ${PENDING_DB_PATH}: ${error.message}\n`,
        );
    }
}
