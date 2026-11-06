// A consumer built the way `bun init` configures it (`lib: ["ESNext"]`, no DOM) with `skipLibCheck: false`.
// Any DOM-only global name in a published declaration (FormDataEntryValue, HeadersInit, BodyInit, JsonWebKey, ...)
// surfaces here as an unresolved name instead of silently becoming `any`.
import * as cli from '@kivin/cli';
import * as config from '@kivin/config';
import * as core from '@kivin/core';
import * as decorators from '@kivin/decorators';
import * as graphql from '@kivin/graphql';
import * as http from '@kivin/http';
import * as jwt from '@kivin/jwt';
import * as logger from '@kivin/logger';
import * as observability from '@kivin/observability';
import * as openapi from '@kivin/openapi';
import * as schedule from '@kivin/schedule';
import * as security from '@kivin/security';
import * as session from '@kivin/session';
import * as standardSchema from '@kivin/standard-schema';
import * as staticFiles from '@kivin/static';
import * as valibot from '@kivin/valibot';
import { createClient } from '../../examples/basic/.kivin/generated/client';

export const packages = { cli, config, core, decorators, graphql, http, jwt, logger, observability, openapi, schedule, security, session, standardSchema, staticFiles, valibot };
export const client = createClient;
