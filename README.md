# Simple pg Migrate Tool

Tooling for very simple postgres migrations. It creates a new database table called `schema_migrations` to track which migrations have been executed on the schema so far. The tool can be executed with `simple-pg-migrate` or `spg-migrate` commands.

Configurations:

The following environment variables can be set to configure the cli.

- `PG_CONNECTION_STRING` - the postgres connection string to connect to the target database
- `MIGRATION_TABLE_NAME` - table name used to store the migrations. _Defaults_ to `schema_migrations`
- `MIGRATION_DIRECTORY` - directory with the sql migrations. _Defaults_ to `./migrations`

Commands:

- `make <migration_name>`: Create a new migration in the migration directory
- `new <migration_name>`: Alias for `make`
- `migrate`: Execute migrations
- `diff`: Finds any schema differences between the existing migrations and a target database and prints them to std out (beta - see below)

**Note: Do not use this tool in production. It is meant as a tool for development purposes. To be production ready, at least a solid test base is missing.**

## Diff Information

The diff command is heavily influences by supabase' `db diff` cli command. You need to have docker installed. It will execute the following process:

- Start a fresh postgres database in a new container (we call this the shadow database). The shadow database is exposed on port 7654
- Apply all migrations to the shadow database
- Run the `migra` python package (https://pypi.org/project/migra/) to compare the shadow database against the target database
  - For this step we use the `supabase/migra` container image.
- Print the output of the `migra` tool to std out
- Remove the migra and postgres containers again

This feature is flagged as beta since some assumptions are made in the code as how to execute this command. It can be a lot improved by enhancing the networking between the containers for instance.