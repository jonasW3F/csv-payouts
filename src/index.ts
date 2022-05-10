import { Command } from 'commander';
import { load } from 'js-yaml';
import { readFileSync, createWriteStream, existsSync, WriteStream } from 'fs';
import { parse } from 'csv-parse';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { KeyringPair, KeyringPair$Json } from '@polkadot/keyring/types';
import { Keyring } from '@polkadot/keyring';
import { createLogger } from '@w3f/logger';
import { Cache } from './cache';

const CACHE_PATH = '.action_cache.json';

type Config = {
	end_point: string;
	actionFilePath: string;
	keystore: Keystore;
}

type Keystore = {
	walletFilePath: string;
	password: string;
}

export type Record = {
	to: string;
	amount: number;
}

export type ToExecute = {
	to: string;
	amount: number;
}

function abort() {
	process.exit(1);
}

const start = async (args: { config: string }): Promise<void> => {
	const log = createLogger("debug");

	// Parse Config
	log.debug(`Reading config from file ${args.config}`);
	const config = load(readFileSync(args.config, "utf8")) as Config;

	// Parse CSV file
	log.debug(`Reading from file ${config.actionFilePath}`);
	let content = readFileSync(config.actionFilePath, 'utf8');

	let records: Record[] = [];
	const parser = parse({ delimiter: "," });
	parser
		.on('readable', (data) => {
			let record;
			while ((record = parser.read()) !== null) {
				records.push(record as Record);
			}
		});

	parser.write(content);
	parser.end();

	log.info(`Parsed ${records.length} CSV entries`);

	// Parse and decode provided account.
	log.info(`Reading account key from ${config.keystore.walletFilePath}`);
	const keyring = new Keyring({ type: 'sr25519' });
	const json = JSON.parse(readFileSync(config.keystore.walletFilePath, 'utf8'));
	const account = keyring.addFromJson(json);
	account.decodePkcs8(config.keystore.password);

	if (account.isLocked) {
		log.error("Failed to initialize keystore, account is locked");
		abort();
	}

	// Init caching.
	let cache = new Cache(CACHE_PATH);
	const [to_execute, danlging] = cache.stageActions(records);

	if (danlging.length != 0) {
		log.warn(
			"There are some staged actions there weren't \
			executed yet and are no longer present in the action file:"
		);

		danlging.forEach((entry) => {
			log.warn(`To: ${entry.to}, amount: ${entry.amount}`);
		});

		log.error(`Please fix the issue or run the 'unstage' command.`);
		abort();
	}

	// Initialize RPC endpoint.
	const wsProvider = new WsProvider(config.end_point);
	const api = await ApiPromise.create({ provider: wsProvider });

	// For each provided entry in the CSV file, execute the balance.
	for (const entry of to_execute) {
		const txHash = await api.tx.balances
			.transfer(entry.to, entry.amount)
			.signAndSend(account);

		log.info(`Sent ${entry.amount} to ${account} with hash ${txHash}`);
		cache.trackExecution(entry, txHash);
	}
}

const command = new Command()
	.description('Execute the CSV payouts')
	.option('-c, --config [path]', 'Path to config file.', './config/main.csv')
	.action(start);

command.parse();
