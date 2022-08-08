// solana-test-validator -r
// anchor deploy
// anchor test --skip-local-validator --skip-deploy --detach
//  because we are not deploying the program in a new local cluster every time we run this tests,
// it is expected that the setting initialize test fails if it is not the first time
// (becasue the settings account will be already initialized)
import * as anchor from '@project-serum/anchor';
import { AnchorProvider, BN, Program } from '@project-serum/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { expect } from 'chai';
import { MeanMultisig } from '../target/types/mean_multisig';

const MEAN_MULTISIG_OPS = new PublicKey('3TD6SWY9M1mLY2kZWJNavPLhwXvcRsWdnZLRaMzERJBw');
const txSize = 1200;

describe('mean-multisig', () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MeanMultisig as Program<MeanMultisig>;
  let settings: PublicKey, programData: PublicKey;
  let user1: Keypair, user2: Keypair, user3: Keypair, userTest: Keypair, owners: { address: PublicKey; name: string }[];

  before('Setup', async () => {
    [settings] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode('settings'))],
      program.programId
    );
    [programData] = await PublicKey.findProgramAddress(
      [program.programId.toBytes()],
      new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
    );
    await program.methods
      .initSettings()
      .accounts({
        payer: (program.provider as AnchorProvider).wallet.publicKey,
        authority: (program.provider as AnchorProvider).wallet.publicKey,
        program: program.programId,
        programData,
        settings,
        systemProgram: SystemProgram.programId
      })
      .rpc();
  });

  beforeEach('Create users', async () => {
    user1 = await createUser(provider);
    user2 = await createUser(provider);
    user3 = await createUser(provider);
    userTest = await createUser(provider);

    owners = [
      {
        address: user1.publicKey,
        name: 'u1'
      },
      {
        address: user2.publicKey,
        name: 'u2'
      },
      {
        address: user3.publicKey,
        name: 'u3'
      }
    ];
  });

  it('create multisig -> create transaction -> approve -> execute', async () => {
    const multisig = await createMultisig(program, settings, owners, 2, 'Test', 0, user1);

    // create transaction with multiple instructions
    const ix1 = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const ix2 = SystemProgram.transfer({
      fromPubkey: user2.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const transaction = Keypair.generate();

    const createIx = await program.account.transaction.createInstruction(transaction, txSize);

    const title = 'Test transaction';
    const description = 'This is a test transaction';
    const operation = 1;
    let instructions: Instruction[] = [
      {
        programId: ix1.programId,
        accounts: ix1.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix1.data
      },
      {
        programId: ix2.programId,
        accounts: ix2.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix2.data
      }
    ];
    console.log('TX: ', transaction.publicKey.toBase58());

    const [transactionDetail] = await PublicKey.findProgramAddress(
      [multisig.toBuffer(), transaction.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .createTransaction(
        instructions,
        operation,
        title,
        description,
        new BN(new Date().getTime() / 1000).add(new BN(3600))
      )
      .preInstructions([createIx])
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        proposer: user1.publicKey,
        settings,
        transactionDetail,
        opsAccount: MEAN_MULTISIG_OPS,
        systemProgram: SystemProgram.programId
      })
      .signers([transaction, user1])
      .rpc({
        commitment: 'confirmed'
      });
    console.log('Transaction created with multiple instructions\n');

    // execute transaction
    let txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = active
    expect(txAccount.lastKnownProposalStatus).to.equal(1);

    const [multisigSigner] = await PublicKey.findProgramAddress([multisig.toBuffer()], program.programId);

    let remainingAccounts: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[] = [];

    // approve
    await program.methods
      .approve()
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        transactionDetail,
        owner: user1.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user1])
      .rpc({
        commitment: 'confirmed'
      });
    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = active
    expect(txAccount.lastKnownProposalStatus).to.equal(1);

    await program.methods
      .approve()
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        transactionDetail,
        owner: user3.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user3])
      .rpc({
        commitment: 'confirmed'
      });
    console.log('Transaction approved\n');

    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = passed
    expect(txAccount.lastKnownProposalStatus).to.equal(2);
    (txAccount.instructions as any).forEach((instruction: Instruction) => {
      remainingAccounts.push({
        pubkey: instruction.programId,
        isSigner: false,
        isWritable: false
      });
      instruction.accounts.forEach((account) => {
        if (account.pubkey.equals(multisigSigner)) {
          account.isSigner = false;
        }
        remainingAccounts.find((acc) => acc.pubkey!.equals(account.pubkey)) ||
          remainingAccounts.push({
            pubkey: account.pubkey,
            isSigner: account.isSigner || false,
            isWritable: account.isWritable || false
          });
      });
    });

    const balanceBefore = await program.provider.connection.getBalance(userTest.publicKey, 'confirmed');

    await program.methods
      .executeTransaction()
      .accounts({
        multisig: multisig,
        multisigSigner: multisigSigner,
        transaction: transaction.publicKey,
        transactionDetail,
        payer: user1.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user1, user2])
      .remainingAccounts(remainingAccounts)
      .rpc({
        commitment: 'confirmed'
      });
    const balanceAfter = await program.provider.connection.getBalance(userTest.publicKey, 'confirmed');
    if ((balanceAfter - balanceBefore) / LAMPORTS_PER_SOL === 20) {
      console.log('Transaction executed.\n');
    } else {
      console.log("All instructions in transaction isn't executed properly.\n");
    }
    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = executed
    expect(txAccount.lastKnownProposalStatus).to.equal(3);
  });

  it('create multisig -> create transaction -> reject!', async () => {
    const multisig = await createMultisig(program, settings, owners, 2, 'Test', 0, user1);

    // create transaction with multiple instructions
    const ix1 = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const ix2 = SystemProgram.transfer({
      fromPubkey: user2.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const transaction = Keypair.generate();
    const createIx = await program.account.transaction.createInstruction(transaction, txSize);

    const title = 'Test transaction';
    const description = 'This is a test transaction';

    const operation = 1;
    let instructions: Instruction[] = [
      {
        programId: ix1.programId,
        accounts: ix1.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix1.data
      },
      {
        programId: ix2.programId,
        accounts: ix2.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix2.data
      }
    ];
    console.log('TX: ', transaction.publicKey.toBase58());

    const [transactionDetail] = await PublicKey.findProgramAddress(
      [multisig.toBuffer(), transaction.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .createTransaction(
        instructions,
        operation,
        title,
        description,
        new BN(new Date().getTime() / 1000).add(new BN(3600))
      )
      .preInstructions([createIx])
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        proposer: user1.publicKey,
        settings,
        transactionDetail,
        opsAccount: MEAN_MULTISIG_OPS,
        systemProgram: SystemProgram.programId
      })
      .signers([transaction, user1])
      .rpc({
        commitment: 'confirmed'
      });
    console.log('Transaction created with multiple instructions\n');

    let txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');
    // proposal status = active
    expect(txAccount.lastKnownProposalStatus).to.equal(1);

    const [multisigSigner] = await PublicKey.findProgramAddress([multisig.toBuffer()], program.programId);

    let remainingAccounts: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[] = [];

    // reject
    await program.methods
      .reject()
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        transactionDetail,
        owner: user2.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user2])
      .rpc({
        commitment: 'confirmed'
      });
    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = active
    expect(txAccount.lastKnownProposalStatus).to.equal(1);

    await program.methods
      .reject()
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        transactionDetail,
        owner: user3.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user3])
      .rpc({
        commitment: 'confirmed'
      });
    console.log('Transaction rejected\n');

    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = failed
    expect(txAccount.lastKnownProposalStatus).to.equal(4);

    (txAccount.instructions as any).forEach((instruction: Instruction) => {
      remainingAccounts.push({
        pubkey: instruction.programId,
        isSigner: false,
        isWritable: false
      });
      instruction.accounts.forEach((account) => {
        if (account.pubkey.equals(multisigSigner)) {
          account.isSigner = false;
        }
        remainingAccounts.find((acc) => acc.pubkey!.equals(account.pubkey)) ||
          remainingAccounts.push({
            pubkey: account.pubkey,
            isSigner: account.isSigner || false,
            isWritable: account.isWritable || false
          });
      });
    });

    try {
      await program.methods
        .executeTransaction()
        .accounts({
          multisig: multisig,
          multisigSigner: multisigSigner,
          transaction: transaction.publicKey,
          transactionDetail,
          payer: user1.publicKey,
          systemProgram: SystemProgram.programId
        })
        .signers([user1, user2])
        .remainingAccounts(remainingAccounts)
        .rpc({
          commitment: 'confirmed'
        });
      throw new Error('Transaction should be rejected');
    } catch (error) {
      expect(error.message).to.include('Not enough owners signed this transactio');
    }
  });

  it('create multisig with cool off -> create transaction -> approve -> try to execute before cool off ', async () => {
    const multisig = await createMultisig(program, settings, owners, 2, 'Test', 1800, user1);

    // create transaction with multiple instructions
    const ix1 = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const ix2 = SystemProgram.transfer({
      fromPubkey: user2.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const transaction = Keypair.generate();
    const createIx = await program.account.transaction.createInstruction(transaction, txSize);

    const title = 'Test transaction';
    const description = 'This is a test transaction';

    const operation = 1;
    let instructions: Instruction[] = [
      {
        programId: ix1.programId,
        accounts: ix1.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix1.data
      },
      {
        programId: ix2.programId,
        accounts: ix2.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix2.data
      }
    ];
    console.log('TX: ', transaction.publicKey.toBase58());

    const [transactionDetail] = await PublicKey.findProgramAddress(
      [multisig.toBuffer(), transaction.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .createTransaction(
        instructions,
        operation,
        title,
        description,
        new BN(new Date().getTime() / 1000).add(new BN(3600))
      )
      .preInstructions([createIx])
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        proposer: user1.publicKey,
        settings,
        transactionDetail,
        opsAccount: MEAN_MULTISIG_OPS,
        systemProgram: SystemProgram.programId
      })
      .signers([transaction, user1])
      .rpc({
        commitment: 'confirmed'
      });
    console.log('Transaction created with multiple instructions\n');

    let txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');
    // proposal status = active
    expect(txAccount.lastKnownProposalStatus).to.equal(1);

    const [multisigSigner] = await PublicKey.findProgramAddress([multisig.toBuffer()], program.programId);

    let remainingAccounts: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[] = [];

    // approve
    await program.methods
      .approve()
      .accounts({
        multisig: multisig,
        transaction: transaction.publicKey,
        transactionDetail,
        owner: user2.publicKey,
        systemProgram: SystemProgram.programId
      })
      .signers([user2])
      .rpc({
        commitment: 'confirmed'
      });
    txAccount = await program.account.transaction.fetch(transaction.publicKey, 'confirmed');

    // proposal status = passed (user1 creates, user2 approves)
    expect(txAccount.lastKnownProposalStatus).to.equal(2);

    (txAccount.instructions as any).forEach((instruction: Instruction) => {
      remainingAccounts.push({
        pubkey: instruction.programId,
        isSigner: false,
        isWritable: false
      });
      instruction.accounts.forEach((account) => {
        if (account.pubkey.equals(multisigSigner)) {
          account.isSigner = false;
        }
        remainingAccounts.find((acc) => acc.pubkey!.equals(account.pubkey)) ||
          remainingAccounts.push({
            pubkey: account.pubkey,
            isSigner: account.isSigner || false,
            isWritable: account.isWritable || false
          });
      });
    });

    try {
      await program.methods
        .executeTransaction()
        .accounts({
          multisig: multisig,
          multisigSigner: multisigSigner,
          transaction: transaction.publicKey,
          transactionDetail,
          payer: user1.publicKey,
          systemProgram: SystemProgram.programId
        })
        .signers([user1, user2])
        .remainingAccounts(remainingAccounts)
        .rpc({
          commitment: 'confirmed'
        });
      throw new Error('Transaction should be rejected');
    } catch (error) {
      expect(error.message).to.include('Cool off period has not reached yet.');
    }
  });

  it('create multisig with cool off -> create transaction with shorter (< cool off) expiry ', async () => {
    const multisig = await createMultisig(program, settings, owners, 2, 'Test', 7200, user1);

    // create transaction with multiple instructions
    const ix1 = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const ix2 = SystemProgram.transfer({
      fromPubkey: user2.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
      toPubkey: userTest.publicKey
    });

    const transaction = Keypair.generate();
    const createIx = await program.account.transaction.createInstruction(transaction, txSize);

    const title = 'Test transaction';
    const description = 'This is a test transaction';

    const operation = 1;
    let instructions: Instruction[] = [
      {
        programId: ix1.programId,
        accounts: ix1.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix1.data
      },
      {
        programId: ix2.programId,
        accounts: ix2.keys.map((key) => ({
          pubkey: key.pubkey,
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix2.data
      }
    ];
    console.log('TX: ', transaction.publicKey.toBase58());

    const [transactionDetail] = await PublicKey.findProgramAddress(
      [multisig.toBuffer(), transaction.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.methods
        .createTransaction(
          instructions,
          operation,
          title,
          description,
          new BN(new Date().getTime() / 1000).add(new BN(3600))
        )
        .preInstructions([createIx])
        .accounts({
          multisig: multisig,
          transaction: transaction.publicKey,
          proposer: user1.publicKey,
          settings,
          transactionDetail,
          opsAccount: MEAN_MULTISIG_OPS,
          systemProgram: SystemProgram.programId
        })
        .signers([transaction, user1])
        .rpc({
          commitment: 'confirmed'
        });
      throw new Error('Transaction should be rejected');
    } catch (error) {
      expect(error.message).to.include('Expiry date comes before cool off period.');
    }
  });
});

const createMultisig = async (
  program: Program<MeanMultisig>,
  settings: PublicKey,
  owners: { address: PublicKey; name: string }[],
  threshold: number,
  label: string,
  coolOffPeriod: number,
  proposer: Keypair
): Promise<PublicKey> => {
  const multisig = Keypair.generate();
  const [, nonce] = await PublicKey.findProgramAddress([multisig.publicKey.toBuffer()], program.programId);

  await program.methods
    .createMultisig(owners, new BN(threshold), nonce, label, new BN(coolOffPeriod))
    .accounts({
      proposer: proposer.publicKey,
      multisig: multisig.publicKey,
      settings,
      opsAccount: MEAN_MULTISIG_OPS,
      systemProgram: SystemProgram.programId
    })
    .signers([proposer, multisig])
    .rpc();
  console.log(`Multisig created ${multisig}\n`);
  return multisig.publicKey;
};

const createUser = async (provider: AnchorProvider) => {
  const user = Keypair.generate();
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 1000 * LAMPORTS_PER_SOL,
      toPubkey: user.publicKey
    })
  );
  await provider.sendAndConfirm(tx);
  return user;
};

function sleep(ms: number) {
  console.log('Sleeping for', ms / 1000, 'seconds');
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Instruction = {
  programId: PublicKey;
  accounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  data: Buffer | undefined;
};
