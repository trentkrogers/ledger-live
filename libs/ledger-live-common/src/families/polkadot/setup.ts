// Goal of this file is to inject all necessary device/signer dependency to coin-modules

import { createBridges } from "@ledgerhq/coin-polkadot/bridge/index";
import type { Transaction } from "@ledgerhq/coin-polkadot/types/index";
import makeCliTools from "@ledgerhq/coin-polkadot/test/cli";
import type { CliTools } from "@ledgerhq/coin-polkadot/test/cli";
import polkadotResolver from "@ledgerhq/coin-polkadot/signer/index";
import Polkadot from "@ledgerhq/hw-app-polkadot";
import Transport from "@ledgerhq/hw-transport";
import type { Bridge } from "@ledgerhq/types-live";
import { CreateSigner, createResolver, executeWithSigner } from "../../bridge/setup";
import { Resolver } from "../../hw/getAddress/types";

const createSigner: CreateSigner<Polkadot> = (transport: Transport) => {
  return new Polkadot(transport);
};

const bridge: Bridge<Transaction> = createBridges(executeWithSigner(createSigner));

const resolver: Resolver = createResolver(createSigner, polkadotResolver);

const cliTools: CliTools = makeCliTools();

export { bridge, cliTools, resolver };
