'use strict';
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
async function main(){
    if(process.argv.length!==3)throw new Error('Uso: node scripts/provisionSeasonLab.js <pasta-nova-absoluta>');
    const manifest=await provisionSeasonLab(process.argv[2]);
    console.log(JSON.stringify(manifest,null,2));
}
if(require.main===module)main().catch(error=>{
    console.error('Provisionamento de laboratório não concluído:',error.message);
    process.exitCode=1;
});
