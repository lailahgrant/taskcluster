const parser = require('cron-parser');
const taskcluster = require('taskcluster-client');
const APIBuilder = require('taskcluster-lib-api');
const nextDate = require('../src/nextdate');
const _ = require('lodash');
const Ajv = require('ajv');

const builder = new APIBuilder({
  title: 'Hooks API Documentation',
  description: [
    'The hooks service provides a mechanism for creating tasks in response to events.',
    '',
  ].join('\n'),
  serviceName: 'hooks',
  apiVersion: 'v1',
  params: {
    hookGroupId: /^[a-zA-Z0-9-_]{1,64}$/,
    hookId: /^[a-zA-Z0-9-_\/]{1,64}$/,
  },
  context: ['Hook', 'LastFire', 'taskcreator', 'publisher', 'denylist'],
});

module.exports = builder;

/** Get hook groups **/
builder.declare({
  method: 'get',
  route: '/hooks',
  name: 'listHookGroups',
  idempotent: true,
  category: 'Hooks Service',
  output: 'list-hook-groups-response.yml',
  title: 'List hook groups',
  stability: 'stable',
  description: [
    'This endpoint will return a list of all hook groups with at least one hook.',
  ].join('\n'),
}, async function(req, res) {
  const groups = new Set();
  await this.Hook.scan({}, {
    handler: (item) => {
      groups.add(item.hookGroupId);
    },
  });
  return res.reply({groups: Array.from(groups)});
});

/** Get hooks in a given group **/
builder.declare({
  method: 'get',
  route: '/hooks/:hookGroupId',
  name: 'listHooks',
  idempotent: true,
  category: 'Hooks Service',
  output: 'list-hooks-response.yml',
  title: 'List hooks in a given group',
  stability: 'stable',
  description: [
    'This endpoint will return a list of all the hook definitions within a',
    'given hook group.',
  ].join('\n'),
}, async function(req, res) {
  const hooks = [];
  await this.Hook.query({
    hookGroupId: req.params.hookGroupId,
  }, {
    handler: async (hook) => {
      hooks.push(await hook.definition());
    },
  });
  if (hooks.length === 0) {
    return res.reportError('ResourceNotFound', 'No such group', {});
  }
  return res.reply({hooks: hooks});
});

/** Get hook definition **/
builder.declare({
  method: 'get',
  route: '/hooks/:hookGroupId/:hookId',
  name: 'hook',
  idempotent: true,
  output: 'hook-definition.yml',
  title: 'Get hook definition',
  category: 'Hooks Service',
  stability: 'stable',
  description: [
    'This endpoint will return the hook definition for the given `hookGroupId`',
    'and hookId.',
  ].join('\n'),
}, async function(req, res) {
  let hook = await this.Hook.load({
    hookGroupId: req.params.hookGroupId,
    hookId: req.params.hookId,
  }, true);

  // Handle the case where the hook doesn't exist
  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  // Reply with the hook definition
  let definition = await hook.definition();
  return res.reply(definition);
});

/** Get hook's current status */
builder.declare({
  method: 'get',
  route: '/hooks/:hookGroupId/:hookId/status',
  name: 'getHookStatus',
  output: 'hook-status.yml',
  title: 'Get hook status',
  stability: 'deprecated',
  category: 'Hooks Service',
  description: [
    'This endpoint will return the current status of the hook.  This represents a',
    'snapshot in time and may vary from one call to the next.',
    '',
    'This method is deprecated in favor of listLastFires.',
  ].join('\n'),
}, async function(req, res) {
  const {hookGroupId, hookId} = req.params;

  const hook = await this.Hook.load({hookGroupId, hookId}, true);
  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  // find the latest entry in the LastFire table for this hook
  let latest = {taskCreateTime: new Date(1970, 1, 1)};
  await this.LastFire.scan({
    hookGroupId: req.params.hookGroupId,
    hookId: req.params.hookId,
  }, {
    handler: item => {
      if (item.taskCreateTime > latest.taskCreateTime) {
        latest = item;
      }
    },
  });

  let reply;

  if (!latest.hookId) {
    reply = {lastFire: {result: 'no-fire'}};
  } else if (latest.result === 'success') {
    reply = {
      lastFire: {
        result: latest.result,
        taskId: latest.taskId,
        time: latest.taskCreateTime.toJSON(),
      },
    };
  } else {
    let error;
    // sometimes the error is JSON, but sometimes it's not (e.g., too large)
    try {
      error = JSON.parse(latest.error);
    } catch (_) {
      error = {message: latest.error};
    }
    reply = {
      lastFire: {
        result: latest.result,
        error,
        time: latest.taskCreateTime.toJSON(),
      },
    };
  }

  // Return a schedule only if a schedule is defined
  if (hook.schedule.length > 0) {
    reply.nextScheduledDate = hook.nextScheduledDate.toJSON();
    // Remark: nextTaskId cannot be exposed here, it's a secret.
    // If someone could predict the taskId they could use it, breaking this
    // service at best, at worst maybe exploit it to elevate from defineTask
    // to createTask without scope to schedule a task.
  }
  return res.reply(reply);
});

/** Create a hook **/
builder.declare({
  method: 'put',
  route: '/hooks/:hookGroupId/:hookId',
  name: 'createHook',
  idempotent: true,
  scopes: {AllOf:
    ['hooks:modify-hook:<hookGroupId>/<hookId>', 'assume:hook-id:<hookGroupId>/<hookId>'],
  },
  input: 'create-hook-request.yml',
  output: 'hook-definition.yml',
  title: 'Create a hook',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'This endpoint will create a new hook.',
    '',
    'The caller\'s credentials must include the role that will be used to',
    'create the task.  That role must satisfy task.scopes as well as the',
    'necessary scopes to add the task to the queue.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;
  const hookDef = req.body;
  const ajv = new Ajv({format: 'full', verbose: true, allErrors: true});

  if (req.body.hookGroupId && hookGroupId !== req.body.hookGroupId) {
    return res.reportError('InputError', 'Hook Group Ids do not match', {});
  }

  if (req.body.hookId && hookId !== req.body.hookId) {
    return res.reportError('InputError', 'Hook Ids do not match', {});
  }

  hookDef.hookGroupId = hookGroupId;
  hookDef.hookId = hookId;

  await req.authorize({hookGroupId, hookId});

  // Validate cron-parser expressions
  for (let schedElement of hookDef.schedule) {
    try {
      parser.parseExpression(schedElement);
    } catch (err) {
      return res.reportError('InputError',
        '{{message}} in {{schedElement}}', {message: err.message, schedElement});
    }
  }

  // Handle an invalid schema
  let valid = ajv.validateSchema(hookDef.triggerSchema);
  if (!valid) {

    const errors = [];

    for (let index = 0; index < ajv.errors.length; index++) {
      errors.push(' * Property ' + ajv.errors[index].dataPath + ' ' + ajv.errors[index].message);
    }

    return res.reportError('InputError', '{{message}}', {
      message: 'triggerSchema is not a valid JSON schema:\n' + errors.join('\n'),
    });
  }

  let denied = await isDeniedBinding({
    bindings: hookDef.bindings || [],
    denylist: this.denylist,
  });
  if (denied) {
    return res.reportError('InputError', '{{message}}', {
      message: 'One or more of the exchanges below have been denied access to hooks\n' + JSON.stringify(hookDef.bindings),
    });
  }

  // Try to create a Hook entity
  try {
    await this.Hook.create(
      _.defaults({}, hookDef, {
        bindings: [],
        triggerToken: taskcluster.slugid(),
        lastFire: {result: 'no-fire'},
        nextTaskId: taskcluster.slugid(),
        nextScheduledDate: nextDate(hookDef.schedule),

      }));
  } catch (err) {
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    const existingHook = await this.Hook.load({hookGroupId, hookId}, true);

    if (!_.isEqual(hookDef, await existingHook.definition())) {
      return res.reportError('RequestConflict',
        'hook `' + hookGroupId + '/' + hookId + '` already exists.',
        {});
    }
  }
  this.publisher.hookCreated({hookGroupId, hookId});
  // Reply with the hook definition
  return res.reply(hookDef);
});

/** Update hook definition**/
builder.declare({
  method: 'post',
  route: '/hooks/:hookGroupId/:hookId',
  name: 'updateHook',
  idempotent: true,
  scopes: {AllOf:
    ['hooks:modify-hook:<hookGroupId>/<hookId>', 'assume:hook-id:<hookGroupId>/<hookId>'],
  },
  input: 'create-hook-request.yml',
  output: 'hook-definition.yml',
  title: 'Update a hook',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'This endpoint will update an existing hook.  All fields except',
    '`hookGroupId` and `hookId` can be modified.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;
  const hookDef = req.body;
  const ajv = new Ajv({format: 'full', verbose: true, allErrors: true});

  if (req.body.hookGroupId && hookGroupId !== req.body.hookGroupId) {
    return res.reportError('InputError', 'Hook Group Ids do not match', {});
  }

  if (req.body.hookId && hookId !== req.body.hookId) {
    return res.reportError('InputError', 'Hook Ids do not match', {});
  }

  hookDef.hookGroupId = hookGroupId;
  hookDef.hookId = hookId;

  await req.authorize({hookGroupId, hookId});

  const hook = await this.Hook.load({hookGroupId, hookId}, true);

  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  //Handle an invalid schema
  let valid = ajv.validateSchema(hookDef.triggerSchema);

  if (!valid) {
    const errors = [];

    for (let index = 0; index < ajv.errors.length; index++) {
      errors.push(' * Property ' + ajv.errors[index].dataPath + ' ' + ajv.errors[index].message);
    }

    return res.reportError('InputError', '{{message}}', {
      message: 'triggerSchema is not a valid JSON schema:\n' + errors.join('\n'),
    });
  }

  // Attempt to modify properties of the hook
  const schedule = hookDef.schedule ? hookDef.schedule : [];
  for (let schedElement of schedule) {
    try {
      parser.parseExpression(schedElement);
    } catch (err) {
      return res.reportError('InputError',
        '{{message}} in {{schedElement}}', {message: err.message, schedElement});
    }
  }
  hookDef.bindings = _.defaultTo(hookDef.bindings, hook.bindings);

  let denied = await isDeniedBinding({
    bindings: hookDef.bindings,
    denylist: this.denylist,
  });
  if (denied) {
    return res.reportError('InputError', '{{message}}', {
      message: 'One or more of the exchanges below have been denied access to hooks\n' + JSON.stringify(hookDef.bindings),
    });
  }

  await hook.modify((hook) => {
    hook.metadata = hookDef.metadata;
    hook.bindings = hookDef.bindings;
    hook.task = hookDef.task;
    hook.triggerSchema = hookDef.triggerSchema;
    hook.schedule = schedule;
    hook.nextTaskId = taskcluster.slugid();
    hook.nextScheduledDate = nextDate(schedule);
  });

  let definition = await hook.definition();
  this.publisher.hookUpdated({hookGroupId, hookId});

  return res.reply(definition);
});

/** Delete hook definition**/
builder.declare({
  method: 'delete',
  route: '/hooks/:hookGroupId/:hookId',
  name: 'removeHook',
  idempotent: true,
  scopes: 'hooks:modify-hook:<hookGroupId>/<hookId>',
  title: 'Delete a hook',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'This endpoint will remove a hook definition.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;

  await req.authorize({hookGroupId, hookId});

  // Remove the resource if it exists
  await this.Hook.remove({hookGroupId, hookId}, true);
  this.publisher.hookDeleted({hookGroupId, hookId});

  await this.LastFire.query({
    hookGroupId: req.params.hookGroupId,
    hookId: req.params.hookId,
  }, {
    handler: async (lastFire) => {
      await lastFire.remove(false, true);
    },
  });
  return res.status(200).json({});
});

/** Trigger a hook **/
builder.declare({
  method: 'post',
  route: '/hooks/:hookGroupId/:hookId/trigger',
  name: 'triggerHook',
  scopes: 'hooks:trigger-hook:<hookGroupId>/<hookId>',
  input: 'trigger-hook.yml',
  output: 'trigger-hook-response.yml',
  title: 'Trigger a hook',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'This endpoint will trigger the creation of a task from a hook definition.',
    '',
    'The HTTP payload must match the hook\s `triggerSchema`.  If it does, it is',
    'provided as the `payload` property of the JSON-e context used to render the',
    'task template.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;

  await req.authorize({hookGroupId, hookId});

  const payload = req.body;
  const clientId = await req.clientId();
  const hook = await this.Hook.load({hookGroupId, hookId}, true);

  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }
  return triggerHookCommon.call(this, {req, res, hook, payload, clientId, firedBy: 'triggerHook'});
});

/** Get secret token for a trigger **/
builder.declare({
  method: 'get',
  route: '/hooks/:hookGroupId/:hookId/token',
  name: 'getTriggerToken',
  scopes: 'hooks:get-trigger-token:<hookGroupId>/<hookId>',
  input: undefined,
  output: 'trigger-token-response.yml',
  title: 'Get a trigger token',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'Retrieve a unique secret token for triggering the specified hook. This',
    'token can be deactivated with `resetTriggerToken`.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;
  await req.authorize({hookGroupId, hookId});

  const hook = await this.Hook.load({hookGroupId, hookId}, true);

  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  return res.reply({
    token: hook.triggerToken,
  });
});

/** Reset a trigger token **/
builder.declare({
  method: 'post',
  route: '/hooks/:hookGroupId/:hookId/token',
  name: 'resetTriggerToken',
  scopes: 'hooks:reset-trigger-token:<hookGroupId>/<hookId>',
  input: undefined,
  output: 'trigger-token-response.yml',
  title: 'Reset a trigger token',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'Reset the token for triggering a given hook. This invalidates token that',
    'may have been issued via getTriggerToken with a new token.',
  ].join('\n'),
}, async function(req, res) {
  const hookGroupId = req.params.hookGroupId;
  const hookId = req.params.hookId;

  await req.authorize({hookGroupId, hookId});

  let hook = await this.Hook.load({hookGroupId, hookId}, true);

  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  await hook.modify((hook) => {
    hook.triggerToken = taskcluster.slugid();
  });

  return res.reply({
    token: hook.triggerToken,
  });
});

/** Trigger hook from a webhook with a token **/
builder.declare({
  method: 'post',
  route: '/hooks/:hookGroupId/:hookId/trigger/:token',
  name: 'triggerHookWithToken',
  input: 'trigger-hook.yml',
  output: 'trigger-hook-response.yml',
  title: 'Trigger a hook with a token',
  stability: 'stable',
  category: 'Hooks Service',
  description: [
    'This endpoint triggers a defined hook with a valid token.',
    '',
    'The HTTP payload must match the hook\s `triggerSchema`.  If it does, it is',
    'provided as the `payload` property of the JSON-e context used to render the',
    'task template.',
  ].join('\n'),
}, async function(req, res) {
  const payload = req.body;

  const hook = await this.Hook.load({
    hookGroupId: req.params.hookGroupId,
    hookId: req.params.hookId,
  }, true);

  // Return a 404 if the hook entity doesn't exist
  if (!hook) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }

  // Return 401 if the token doesn't exist or doesn't match
  if (req.params.token !== hook.triggerToken) {
    return res.reportError('AuthenticationFailed', 'invalid hook token', {});
  }

  return triggerHookCommon.call(this, {req, res, hook, payload, firedBy: 'triggerHookWithToken'});
});

/**
 * Common implementation of triggerHook and triggerHookWithToken
 */
const triggerHookCommon = async function({req, res, hook, payload, clientId, firedBy}) {
  const ajv = new Ajv({format: 'full', verbose: true, allErrors: true});
  const context = {firedBy, payload };
  if (clientId) {
    context.clientId = clientId;
  }
  let resp;
  let error;

  //Using ajv lib to check if the context respect the triggerSchema
  const validate = ajv.compile(hook.triggerSchema);

  let valid = validate(payload);
  if (!valid) {
    return res.reportError('InputError', '{{message}}', {
      message: ajv.errorsText(validate.errors, {separator: '; '}),
    });
  }

  try {
    resp = await this.taskcreator.fire(hook, context);
    if (!resp) {
      // hook did not produce a response, so return an empty object
      return res.reply({});
    }
  } catch (err) {
    error = err;
  }

  if (resp) {
    return res.reply(resp);
  } else if (error.body && error.body.requestInfo) {
    // handle errors from createTask specially (since they are usually about scopes)
    if (error.body.requestInfo.method === 'createTask' && error.body.code === 'InsufficientScopes') {
      return res.reportError(
        'InsufficientScopes',
        `The role \`hook-id:${hook.hookGroupId}/${hook.hookId}\` does not have sufficient scopes ` +
        `to create the task:\n\n${error.body.message}`,
        {createTask: error.body.requestInfo});
    }
    return res.reportError(
      'InputError',
      'While calling {{method}}: {{code}}\n\n{{message}}', {
        code: error.body.code,
        method: error.body.requestInfo.method,
        message: error.body.message,
      });
  } else {
    return res.reportError(
      'InputError',
      'While firing hook:\n\n{{error}}',
      {error: (error || 'unknown').toString()});
  }
};

const isDeniedBinding = async ({bindings, denylist}) => {
  for (let deny of denylist) {
    for (let binding of bindings) {
      const denyPattern = new RegExp(`^${deny}`);
      if (denyPattern.test(binding.exchange)) {
        return true;
      }
    }
  }

  return false;
};
/**
 * Get information about recent fires of a hook
*/
builder.declare({
  method: 'get',
  route: '/hooks/:hookGroupId/:hookId/last-fires',
  name: 'listLastFires',
  idempotent: true,
  output: 'list-lastFires-response.yml',
  title: 'Get information about recent hook fires',
  stability: 'experimental',
  category: 'Hooks Service',
  description: [
    'This endpoint will return information about the the last few times this hook has been',
    'fired, including whether the hook was fired successfully or not',
  ].join('\n'),
}, async function(req, res) {
  let lastFires = [], item;
  await this.LastFire.query({
    hookGroupId: req.params.hookGroupId,
    hookId: req.params.hookId,
  }, {handler: async (lastFire) => {
    item = await lastFire.definition();
    item.taskCreateTime = item.taskCreateTime.toJSON();
    lastFires.push(item);
  }});

  if (lastFires.length === 0) {
    return res.reportError('ResourceNotFound', 'No such hook', {});
  }
  return res.reply({lastFires: lastFires});
});
