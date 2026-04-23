import { Command } from 'commander';
import { runKeyGen } from './commands/key-gen.ts';
import { runKeyPub } from './commands/key-pub.ts';
import { runKeyValidate } from './commands/key-validate.ts';
import {
  runVkHashAddress,
  type VkHashAddressOptions,
} from './commands/vk-hash-address.ts';
import { runVkHashCompile } from './commands/vk-hash-compile.ts';
import { runFundAccounts } from './commands/fund-accounts.ts';
import { runLightnetFixture } from './commands/lightnet-fixture.ts';

/** Dispatches `vk-hash <mode>` CLI invocations to the right handler. */
async function handleVkHashCommand(
  mode: string,
  options: { address?: string; minaEndpoint?: string }
): Promise<void> {
  if (mode === 'compile') {
    await runVkHashCompile();
    return;
  }

  if (mode === 'address') {
    if (!options.address) {
      throw new Error('Missing required --address for `vk-hash address`.');
    }
    const addressOptions: VkHashAddressOptions = {
      address: options.address,
      minaEndpoint: options.minaEndpoint,
    };
    await runVkHashAddress(addressOptions);
    return;
  }

  throw new Error(`Unknown vk-hash mode: ${mode}`);
}

/** Dispatches `key <mode>` CLI invocations to the right handler. */
async function handleKeyCommand(
  mode: string,
  options: { privateKey?: string }
): Promise<void> {
  if (mode === 'gen') {
    await runKeyGen();
    return;
  }

  if (mode === 'pub') {
    if (!options.privateKey) {
      throw new Error('Missing required --private-key for `key pub`.');
    }
    await runKeyPub(options.privateKey);
    return;
  }

  if (mode === 'validate') {
    if (!options.privateKey) {
      throw new Error('Missing required --private-key for `key validate`.');
    }
    await runKeyValidate(options.privateKey);
    return;
  }

  throw new Error(`Unknown key mode: ${mode}`);
}

/** Executes the CLI and converts runtime failures into non-zero exit code. */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('dev-helpers')
    .description('Standalone MinaGuard helper CLI')
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command('vk-hash')
    .description('Verification key hash helpers')
    .argument('<mode>', 'compile | address')
    .option('--address <address>', 'zkApp address (B62...)')
    .option('--mina-endpoint <url>', 'Mina GraphQL endpoint override')
    .action(async (mode: string, options: { address?: string; minaEndpoint?: string }) => {
      await handleVkHashCommand(mode, options);
    });

  program
    .command('key')
    .description('Private/public key helpers')
    .argument('<mode>', 'gen | pub | validate')
    .option('--private-key <privateKey>', 'Private key (EK...)')
    .action(async (mode: string, options: { privateKey?: string }) => {
      await handleKeyCommand(mode, options);
    });

  program
    .command('lightnet-fund')
    .description('Fund all public keys from .env via lightnet account manager')
    .action(async () => {
      await runFundAccounts();
    });

  program
    .command('lightnet-fixture')
    .description('Deploy real on-chain fixture contracts to the local preview lightnet')
    .requiredOption('--main-address <address>', 'Main wallet address to include as an owner on all fixture contracts')
    .option(
      '--scenario <scenario>',
      'Fixture scenario to seed: minimal | full',
      'minimal'
    )
    .option(
      '--preview-base-url <url>',
      'Preview base URL that exposes /graphql, /archive, /accounts, and /api',
      'https://localhost:10001/preview/1'
    )
    .action(async (options: { mainAddress: string; previewBaseUrl: string; scenario: 'minimal' | 'full' }) => {
      await runLightnetFixture({
        mainAddress: options.mainAddress,
        previewBaseUrl: options.previewBaseUrl,
        scenario: options.scenario,
      });
    });

  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
