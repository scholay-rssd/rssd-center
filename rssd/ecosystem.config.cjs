module.exports={apps:[
 {name:'backend',cwd:'/app/apps/backend',script:'dist/apps/backend/src/main.js',node_args:'--experimental-require-module',kill_timeout:20000},
 {name:'frontend',cwd:'/app/apps/frontend',script:'/app/node_modules/next/dist/bin/next',args:'start -p 4200',kill_timeout:20000},
 ...(process.env.RSSD_POSTIZ_ORCHESTRATOR_ENABLED==='0'?[]:[{name:'orchestrator',cwd:'/app/apps/orchestrator',script:'dist/apps/orchestrator/src/main.js',node_args:'--experimental-require-module',kill_timeout:30000}])
]};
