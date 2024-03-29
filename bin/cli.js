#!/usr/bin/env node

import postgres from 'postgres';
import fs from 'fs';
import { format } from 'date-fns';
import Docker from 'dockerode';

const { PG_CONNECTION_STRING } = process.env;
const MIGRATION_TABLE_NAME = process.env.MIGRATION_TABLE_NAME || 'schema_migrations';
const MIGRATION_DIRECTORY = process.env.MIGRATION_DIRECTORY || './migrations';

async function migrate(pgConnectionString) {
  const sql = postgres(pgConnectionString);

  // create migration table
  await sql`CREATE TABLE IF NOT EXISTS ${sql(MIGRATION_TABLE_NAME)} (migration_name TEXT NOT NULL PRIMARY KEY, migration_date TIMESTAMP NOT NULL DEFAULT NOW())`;

  const files = fs.readdirSync(MIGRATION_DIRECTORY);

  if (files.length === 0) {
    console.log('No migration files found');
    return;
  }

  // get already executed migrations
  let allMigrations = await sql`SELECT migration_name FROM ${sql(MIGRATION_TABLE_NAME)} ORDER BY migration_name ASC`;

  // check the provided migration files match with the already executed ones in the database and find the next file to execute
  let startIdx = 0;
  for (let i = 0; i < allMigrations.length; i++) {
    if (allMigrations[i].migration_name !== files[i]) {
      throw new Error('Provided migration files do not match with executed files on the database!');
    } else if (i >= files.length) {
      break;
    } else {
      startIdx = i + 1;
    }
  }

  if (startIdx >= files.length) {
    console.log('No new migrations to execute');
    return;
  }

  // excute new migrations in a new transaction
  try {
    await sql.begin(async (tx) => {
      for (let i = startIdx; i < files.length; i++) {
        await tx.file(`${MIGRATION_DIRECTORY}/${files[i]}`);
        await tx`INSERT INTO ${sql(MIGRATION_TABLE_NAME)} (migration_name) VALUES (${files[i]})`;
      }
    });
  } catch (e) {
    console.error(e);
    throw new Error('Executing migrations failed!');
  }

  await sql.end();
}

function createMigrationFile() {
  let name = process.argv[3];

  if (name == null) {
    throw new Error('Please provide a new for the migration');
  }

  let date = format(new Date(), 'yyyyMMddHHmmss');
  fs.writeFileSync(`${MIGRATION_DIRECTORY}/${date}_${name}.sql`, '');
}

async function diff() {
  const initialMigrationPath = process.argv[3];

  const docker = new Docker();

  let migraContainerId = null;
  let migraContainer = null;
  let postgresContainerId = null;
  let postgresContainer = null;
  try {
    // Start Shadow Database
    console.log('Creating Shadow Database...');
    postgresContainer = await docker.createContainer({
      Image: 'postgres:latest',
      Env: [
        'POSTGRES_USER=postgres',
        'POSTGRES_PASSWORD=root',
        'POSTGRES_DB=postgres',
      ],
      HostConfig: {
        PortBindings: {
          '5432/tcp': [{ HostPort: '7654' }]
        },
      },
      Healthcheck: {
        Test: [
          "CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432",
        ],
        Interval: 10 * 1000 * 1000000,
        Timeout: 2 * 1000 * 1000000,
        Retries: 3,
      },
      AttachStdout: false,
      AttachStderr: false,
    });
    postgresContainerId = postgresContainer.id;
    await postgresContainer.start();

    // wait for the postgres to be ready
    let containerHealthy = false;
    let retryCount = 0;
    while (!containerHealthy) {
      if (retryCount > 20) {
        break;
      }
      let postgrestState = await postgresContainer.inspect();
      if (postgrestState?.State?.Health?.Status === 'healthy') {
        containerHealthy = true;
      } else {
        await new Promise((resolve) => { setTimeout(resolve, 1000) });
      }
      retryCount++;
    }

    if (!containerHealthy) {
      console.error('Error creating shadow database...');
      throw new Error('Cannot create shadow database');
    }

    // run the initial migration if provided
    if (initialMigrationPath != null) {
      let sql = postgres('postgres://postgres:root@localhost:7654/postgres');
      await sql.file(initialMigrationPath);
      await sql.end();
    }

    // run the available migrations
    console.log('Applying migrations to the shadow database...')
    await migrate('postgres://postgres:root@localhost:7654/postgres');

    // Check Migration
    migraContainer = await docker.createContainer({
      Image: 'public.ecr.aws/supabase/migra:3.0.1663481299',
      Cmd: [
        "/bin/sh",
        "-c",
        `migra --unsafe --schema public postgresql://postgres:root@host.docker.internal:7654/postgres ${PG_CONNECTION_STRING.replace('postgres://', 'postgresql://').replace('@localhost', '@host.docker.internal')}`,
      ],
      Tty: true,
    });
    migraContainerId = migraContainer.id;
    console.log('Comparing databases...')
    await migraContainer.start();
    await migraContainer.wait();
    let logs = await migraContainer.logs({ stdout: true, stderr: true,  });
    console.log('Following migrations are necessary:\n');
    console.log(logs.toString());
  } catch (e) {
    console.error('Error while running the migration check container.');
    throw e;
  } finally {
    let promises = [
      // ...(migraContainerId != null && migraContainer != null ? [migraContainer.remove({ force: true })] : []),
      ...(postgresContainerId != null && postgresContainer != null ? [postgresContainer.remove({ force: true })] : [])
    ];
    let results = await Promise.allSettled(promises);

    if (results[0]?.status === 'rejected') {
      console.error(`Error removing container with id ${migraContainerId || postgresContainerId}. Please make sure to remove the container (docker rm --force ${migraContainerId || postgresContainerId})`);
    }
    if (results[1]?.status === 'rejected') {
      console.error(`Error removing container with id ${postgresContainerId}. Please make sure to remove the container (docker rm --force ${postgresContainerId})`);
    }
  }
}

//////////////////////////////

const cmd = process.argv[2];

try {
  if (cmd === 'make' || cmd === 'new') {
    createMigrationFile();
  } else if (cmd === 'migrate') {
    if (PG_CONNECTION_STRING == null) {
      throw new Error('Please provide connection string as env variable');
    }

    migrate(PG_CONNECTION_STRING)
      .then(() => console.log('Successfully executed migrations'))
      .catch((e) => {
        console.error('Failed to upgrade migrations');
        console.error(e);
        process.exit(1);
      });
  } else if (cmd === 'diff') {
    if (PG_CONNECTION_STRING == null) {
      throw new Error('Please provide connection string as env variable');
    }

    diff()
      .catch((e) => {
        console.error('Failed to diff dbs');
        console.error(e);
        process.exit(1);
      });
  } else {
    console.error('Command unknown or none specified. Provide either ("make" | "new") to create a new migration file template or "migrate" as first argument');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
