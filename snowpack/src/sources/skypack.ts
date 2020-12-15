import * as colors from 'kleur/colors';
import path from 'path';
import {
  buildNewPackage,
  fetchCDN,
  installTypes,
  lookupBySpecifier,
  rollupPluginSkypack,
  SKYPACK_ORIGIN,
} from 'skypack';
import {logger} from '../logger';
import {isJavaScript} from '../util';
import {ImportMap, LockfileManifest, PackageSource, SnowpackConfig} from '../types/snowpack';
import {getInstallTargets} from '../commands/install';

const fetchedPackages = new Set<string>();
function logFetching(packageName: string) {
  if (fetchedPackages.has(packageName)) {
    return;
  }
  fetchedPackages.add(packageName);
  logger.info(
    `Fetching latest ${colors.bold(packageName)} ${colors.dim(
      `→ ${SKYPACK_ORIGIN}/${packageName}`,
    )}`,
    {name: 'source:skypack'},
  );
}

function parseRawPackageImport(spec: string): [string, string | null] {
  const impParts = spec.split('/');
  if (spec.startsWith('@')) {
    const [scope, name, ...rest] = impParts;
    return [`${scope}/${name}`, rest.join('/') || null];
  }
  const [name, ...rest] = impParts;
  return [name, rest.join('/') || null];
}

/**
 * Skypack Package Source: A generic interface through which
 * Snowpack interacts with the Skypack CDN. Used to load dependencies
 * from the CDN during both development and optimized building.
 */
export default {
  async prepare(commandOptions) {
    const {config, lockfile} = commandOptions;
    const installTargets = await getInstallTargets(config);
    if (installTargets.length === 0) {
      logger.info('Nothing to install.');
      return;
    }

    for (const t of installTargets) {
      const spec = t.specifier;
      const [packageName] = parseRawPackageImport(spec);
      let lookupSpec: string = packageName;
      if (lockfile && lockfile.imports[spec]) {
        // TODO!
        // lookupSpec = lockfile.imports[spec];
      } else {
        // TODO: When config.root is added, look up package.json "dependencies" & "devDependencies"
        // from the root and fallback to those if lockfile.dependencies[packageName] doesn't exist.
        const _packageSemver = lockfile?.dependencies && lockfile.dependencies[packageName];
        if (!_packageSemver) {
          logFetching(packageName);
        } else {
          // TODO!
          // lookupSpec += '@' + _packageSemver;
        }
      }
      await installTypes(lookupSpec);
    }

    // Skypack resolves imports on the fly, so no import map needed.
    return {imports: {}};
  },

  async modifyBuildInstallConfig({
    config,
    lockfile,
  }: {
    config: SnowpackConfig;
    lockfile: LockfileManifest | null;
  }) {
    config.installOptions.lockfile = lockfile || undefined;
    config.installOptions.rollup = config.installOptions.rollup || {};
    config.installOptions.rollup.plugins = config.installOptions.rollup.plugins || [];
    config.installOptions.rollup.plugins.push(rollupPluginSkypack({}) as Plugin);
  },

  async load(
    spec: string,
    {config, lockfile}: {config: SnowpackConfig; lockfile: LockfileManifest | null},
  ): Promise<string | Buffer> {
    let body: Buffer;
    if (
      spec.startsWith('-/') ||
      spec.startsWith('pin/') ||
      spec.startsWith('new/') ||
      spec.startsWith('error/')
    ) {
      body = (await fetchCDN(`/${spec}`)).body;
    } else {
      const [packageName, packagePath] = parseRawPackageImport(spec);
      if (lockfile && lockfile.imports[spec]) {
        body = (await fetchCDN(lockfile.imports[spec])).body;
      } else if (lockfile && lockfile.imports[packageName + '/']) {
        body = (await fetchCDN(lockfile.imports[packageName + '/'] + packagePath)).body;
      } else {
        // TODO: When config.root is added, look up package.json "dependencies" & "devDependencies"
        // from the root and fallback to those if lockfile.dependencies[packageName] doesn't exist.
        const _packageSemver = lockfile?.dependencies && lockfile.dependencies[packageName];
        if (!_packageSemver) {
          logFetching(packageName);
        }
        const packageSemver = _packageSemver || 'latest';
        let lookupResponse = await lookupBySpecifier(spec, packageSemver);
        if (!lookupResponse.error && lookupResponse.importStatus === 'NEW') {
          const buildResponse = await buildNewPackage(spec, packageSemver);
          if (!buildResponse.success) {
            throw new Error('Package could not be built!');
          }
          lookupResponse = await lookupBySpecifier(spec, packageSemver);
        }
        if (lookupResponse.error) {
          throw lookupResponse.error;
        }
        body = lookupResponse.body;
      }
    }
    const ext = path.extname(spec);
    if (!ext || isJavaScript(spec)) {
      return body
        .toString()
        .replace(/(from|import) \'\//g, `$1 '${config.buildOptions.webModulesUrl}/`)
        .replace(/(from|import) \"\//g, `$1 "${config.buildOptions.webModulesUrl}/`);
    }

    return body;
  },

  resolvePackageImport(missingPackage: string, _: ImportMap, config: SnowpackConfig): string {
    return path.posix.join(config.buildOptions.webModulesUrl, missingPackage);
  },

  async recoverMissingPackageImport(): Promise<ImportMap> {
    throw new Error('Unexpected Error: No such thing as a "missing" package import with Skypack.');
  },
} as PackageSource;
