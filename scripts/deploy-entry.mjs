// Only Cloudflare's explicit build environment selects the remote button path.
// Local pnpm run deploy remains the existing offline-plan CLI unless --apply is explicit.
if(process.env.WORKERS_CI==='1'&&process.argv.length===2){
  const {runWorkersBuilds}=await import('./deploy-workers-builds.mjs');await runWorkersBuilds();
}else await import('./deploy.mjs');
