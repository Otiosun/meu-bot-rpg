'use strict';
const {verifySeasonLab}=require('../helpers/clover/seasonLabProvisioning');
async function main(){
    if(process.argv.length!==3)throw new Error('Uso: node scripts/verifySeasonLab.js <pasta-absoluta>');
    console.log(JSON.stringify(await verifySeasonLab(process.argv[2]),null,2));
}
if(require.main===module)main().catch(error=>{
    console.error('Verificação de laboratório recusada:',error.message);
    process.exitCode=1;
});
