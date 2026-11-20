'use strict';

// This flag identifies an offline candidate; it is not permission to start
// the live bot, site or tunnel. Production cutover is a separate decision.
function assertOnlineStartupAllowed(env=process.env){
    if(String(env.CLOVER_SEASON_LAB_ROOT||'').trim()){
        const error=new Error('A temporada de laboratório está offline. Inicialização online não autorizada.');
        error.code='season_lab_online_forbidden';
        throw error;
    }
}
module.exports={assertOnlineStartupAllowed};
