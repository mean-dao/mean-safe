// solana-test-validator -r
// anchor deploy
// anchor test --skip-local-validator --skip-deploy --detach
//  because we are not deploying the program in a new local cluster every time we run this tests,
// it is expected that the setting initialize test fails if it is not the first time 
// (becasue the settings account will be already initialized)
import * as anchor from "@project-serum/anchor";
import { AnchorProvider, BN, Program } from '@project-serum/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, BPF_LOADER_PROGRAM_ID } from '@solana/web3.js';
import { MeanMultisig } from "../target/types/mean_multisig";

describe("mean-multisig", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const MEAN_MULTISIG_OPS = new PublicKey("3TD6SWY9M1mLY2kZWJNavPLhwXvcRsWdnZLRaMzERJBw");

  const program = anchor.workspace.MeanMultisig as Program<MeanMultisig>;

  it("Creating and executing multi instruction transaction!", async () => {
   const [settings] = await PublicKey.findProgramAddress([Buffer.from(anchor.utils.bytes.utf8.encode("settings"))], program.programId);
    const [programData] = await PublicKey.findProgramAddress([program.programId.toBytes()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")); 
    await program.methods.initSettings().accounts({
        payer: (program.provider as AnchorProvider).wallet.publicKey,
        authority: (program.provider as AnchorProvider).wallet.publicKey,
        program: program.programId,
        programData,
        settings,
        systemProgram: SystemProgram.programId,
      }).rpc();
  
    const user1 = await createUser(provider);
    const user2 = await createUser(provider);
    const user3 = await createUser(provider);
    const userTest = await createUser(provider);
    
    const label = 'Test';
    const threshold = new BN(2);
    const owners = [
        {
            address: user1.publicKey,
            name: "u1"
        },
        {
            address: user2.publicKey,
            name: "u2"
        },
        {
            address: user3.publicKey,
            name: "u3"
        }
    ];

    // create multisig
    const multisig = Keypair.generate();
      const [, nonce] = await PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );
    
    await program.methods
        .createMultisig(owners, new BN(threshold), nonce, label)
        .accounts({
          proposer: user1.publicKey,
          multisig: multisig.publicKey,
          settings,
          opsAccount: MEAN_MULTISIG_OPS,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1, multisig])
        .rpc();
    console.log(`Multisig created ${multisig.publicKey}\n`);


    // create transaction with multiple instructions
    const ix1 = SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
        toPubkey: userTest.publicKey
    });

    const ix2 = SystemProgram.transfer({
        fromPubkey: user2.publicKey,
        lamports:  10* LAMPORTS_PER_SOL,
        toPubkey: userTest.publicKey
    });
    
    const transaction = Keypair.generate();
    const txSize = 1200;
      const createIx = await program.account.transaction.createInstruction(
        transaction,
        txSize
      );

    const title = 'Test transaction';
    const description = "This is a test transaction";
    type Instruction = {
        programId: PublicKey,
        accounts: {
            pubkey: PublicKey,
            isSigner: boolean,
            isWritable: boolean,
        }[],
        data: Buffer | undefined,
    }
    const operation = 1;
    let instructions: Instruction[] = [
            {
                programId: ix1.programId,
                accounts: ix1.keys.map(key => ({pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable})),
                data: ix1.data
            },
            {
                programId: ix2.programId,
                accounts: ix2.keys.map(key => ({pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable})),
                data: ix2.data
            }
        ];    
    console.log("TX: ", transaction.publicKey.toBase58());
         
    await program.methods
        .createTransaction(
          instructions,
          operation,
          title,
          description,
          new BN(new Date().getTime()/1000).add(new BN(3600)),
          new BN(0),
          0,
    )
        .preInstructions([createIx])
        .accounts({
          multisig: multisig.publicKey,
          transaction: transaction.publicKey,
          proposer: user1.publicKey,
          settings,
          opsAccount: MEAN_MULTISIG_OPS,
          systemProgram: SystemProgram.programId,
        })
        .signers([transaction, user1])
        .rpc({
            commitment: 'confirmed',
        });
    console.log("Transaction created with multiple instructions\n");

    // execute transaction
    const txAccount: any = await program.account.transaction.fetch(
        transaction.publicKey,
        'confirmed'
    );
    
      const [multisigSigner] = await PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );

    let remainingAccounts: {
         pubkey: PublicKey;
         isSigner: boolean;
         isWritable: boolean;
    }[] = [];

    // approve
    await program.methods
        .approve()
        .accounts({
          multisig: multisig.publicKey,
          transaction: transaction.publicKey,
          owner: user1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc(
            {
                commitment: 'confirmed',
            }
        );
    await program.methods
        .approve()
        .accounts({
          multisig: multisig.publicKey,
          transaction: transaction.publicKey,
          owner: user3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc(
            {
                commitment: 'confirmed',
            }
        );
    console.log("Transaction approved\n");

    txAccount.instructions.forEach((instruction: Instruction) => {
        remainingAccounts.push({
            pubkey: instruction.programId,
            isSigner: false,
            isWritable: false,
        })
        instruction.accounts.forEach((account) => {
            if (account.pubkey.equals(multisigSigner)) {
                account.isSigner = false;
            }
            remainingAccounts.find(acc => acc.pubkey!.equals(account.pubkey)) || remainingAccounts.push({
                pubkey: account.pubkey,
                isSigner: account.isSigner || false,
                isWritable: account.isWritable || false
            });
        });
    });

      const balanceBefore = await program.provider.connection.getBalance(userTest.publicKey, 'confirmed');
    
    await program.methods
        .executeTransaction(false)
        .accounts({
          multisig: multisig.publicKey,
          multisigSigner: multisigSigner,
          transaction: transaction.publicKey,
          payer: user1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1, user2])
        .remainingAccounts(remainingAccounts)
        .rpc(
            {
                commitment: 'confirmed',
            }
    );
    const balanceAfter = await program.provider.connection.getBalance(userTest.publicKey, 'confirmed');
    if ((balanceAfter - balanceBefore) / LAMPORTS_PER_SOL === 20) {
         console.log("Transaction executed.\n");
    } else {
        console.log("All instructions in transaction isn't executed properly.\n");
    }
  });
});

const createUser = async (provider: AnchorProvider, ) => {
    const user = Keypair.generate();
    const tx = new Transaction();
    tx.add(SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      lamports: 1000 * LAMPORTS_PER_SOL,
      toPubkey: user.publicKey
    }));
    await provider.sendAndConfirm(tx);
    return user;
};

function sleep(ms: number) {
    console.log('Sleeping for', ms / 1000, 'seconds');
    return new Promise((resolve) => setTimeout(resolve, ms));
}