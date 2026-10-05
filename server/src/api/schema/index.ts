import { builder } from '../builder.js';
import './catalog.js';
import './deployment.js';
import './logs.js';
import './mutations.js';
import './subscriptions.js';

export const schema = builder.toSchema({ sortSchema: true });
