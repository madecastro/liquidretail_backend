// Offline proof that deploying the gate split does NOT silently disable QC in prod.
// Simulates the exact live state: new tri-state fields UNSET (null), legacy
// adVisionQcEnabled = true, and config/defaults.env shipping the two NEW env vars
// as 'false'. If precedence were wrong (new env consulted before the legacy DB
// bridge) both resolvers would return false and every ad would ship uninspected.
const path = require('path');
const ROOT = process.argv[2];

// Load the real committed defaults.env so the new env vars are genuinely 'false'.
require('dotenv').config({ path: path.join(ROOT, 'config', 'defaults.env') });
console.log('env STATIC_VISION_QC_ENABLED =', JSON.stringify(process.env.STATIC_VISION_QC_ENABLED));
console.log('env VIDEO_VISION_QC_ENABLED  =', JSON.stringify(process.env.VIDEO_VISION_QC_ENABLED));
console.log('env AD_VISION_QC_ENABLED     =', JSON.stringify(process.env.AD_VISION_QC_ENABLED));

// Stub the SystemConfig model in the require cache BEFORE systemConfigService loads it,
// so the real getter runs its real bridge logic against a fake prod document.
const modelPath = require.resolve(path.join(ROOT, 'models', 'SystemConfig.js'));
const PROD_DOC = { key: 'default', staticVisionQcEnabled: null, videoVisionQcEnabled: null, adVisionQcEnabled: true };
let selected = null;
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true,
  exports: {
    findOne() {
      return { select(f) { selected = f; return { lean: async () => PROD_DOC }; } };
    }
  }
};

(async () => {
  const cfg = require(path.join(ROOT, 'services', 'systemConfigService'));
  const qc = require(path.join(ROOT, 'services', 'adVisionQcService'));

  const gs = await cfg.getStaticVisionQcEnabled();
  const gv = await cfg.getVideoVisionQcEnabled();
  console.log('\ngetter projection string:', JSON.stringify(selected));
  console.log('getStaticVisionQcEnabled() =', gs, '(expect true via legacy bridge)');
  console.log('getVideoVisionQcEnabled()  =', gv, '(expect true via legacy bridge)');

  const rs = await qc.resolveStaticEnabled();
  const rv = await qc.resolveVideoEnabled();
  console.log('resolveStaticEnabled() =', rs);
  console.log('resolveVideoEnabled()  =', rv);

  const ok = gs === true && gv === true && rs === true && rv === true;
  console.log('\n' + (ok
    ? 'PASS — deploying this does NOT turn QC off in production.'
    : 'FAIL — QC WOULD SILENTLY TURN OFF ON DEPLOY. DO NOT MERGE.'));

  // Second scenario: an explicit new-field value must WIN over the legacy field.
  PROD_DOC.staticVisionQcEnabled = false;
  cfg.resetStaticVisionQcEnabledCache && cfg.resetStaticVisionQcEnabledCache();
  const override = await cfg.getStaticVisionQcEnabled();
  console.log('\nexplicit staticVisionQcEnabled=false over legacy true =>', override, '(expect false)');
  console.log(override === false ? 'PASS — explicit new field wins.' : 'FAIL — new field does not override legacy.');
  process.exit(ok && override === false ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
