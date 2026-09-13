import mongoose from "mongoose";
import { env, isProd } from "./env.js";

export async function connectDb(): Promise<void> {
  mongoose.set("strictQuery", true);

  await mongoose.connect(env.mongodbUri, {
    autoIndex: !isProd,
  });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
