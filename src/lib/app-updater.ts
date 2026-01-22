import { promises as fs } from "node:fs";
type db<T> = {
  read(): Promise<T[]>;
  write(data: T[]): Promise<void>;
  filePath: string;
  content?: T[];
}
export class Db<T> implements db<T> {
  filePath: string;
  content?: T[] | undefined;
  constructor( filePath: string="./db.json") {
    this.filePath = filePath;
  }

  async read(): Promise<T[]> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      this.content = JSON.parse(data) as T[];
      return this.content;
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        console.error(`Error reading db file: ${error}`);
      }
      return this.content || [];
    }
  }

  async write(data: T[]): Promise<void> {
    try {
      this.content = data;
      await fs.writeFile(this.filePath, JSON.stringify(this.content, null, 2), "utf8");
    } catch (error: any) {
      console.error(`Error writing db file: ${error}`);
    }
  }
}
