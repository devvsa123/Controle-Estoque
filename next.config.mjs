import { execSync } from "node:child_process";

const git = (cmd) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };

/** @type {import('next').NextConfig} */
export default {
  // Versão do deploy mostrada discretamente no rodapé: commit (Vercel ou git local) e hora do build.
  env: {
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || git("git rev-parse HEAD")).slice(0, 7),
    NEXT_PUBLIC_BUILD_MSG: (process.env.VERCEL_GIT_COMMIT_MESSAGE || git("git log -1 --pretty=%s")).split("\n")[0].slice(0, 120),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};
