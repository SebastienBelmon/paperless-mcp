import { z } from "zod";

const permissionSubjectsSchema = z
  .object({
    users: z.array(z.number()).optional(),
    groups: z.array(z.number()).optional(),
  })
  .strict()
  .optional();

export const ownerSchema = z
  .number()
  .int()
  .nullable()
  .optional()
  .describe(
    "Owner user ID. On create, defaults to the API user when omitted. On update, omitted leaves the owner unchanged; null removes the owner."
  );

export const setPermissionsSchema = z
  .object({
    view: permissionSubjectsSchema,
    change: permissionSubjectsSchema,
  })
  .strict()
  .optional()
  .describe(
    "Users and groups (ID lists) allowed to view and to change the object. On create, sets the initial permissions. On update, each listed users/groups list replaces the existing one; omitted actions (view/change) and omitted lists are left untouched, and an empty list [] clears it."
  );
