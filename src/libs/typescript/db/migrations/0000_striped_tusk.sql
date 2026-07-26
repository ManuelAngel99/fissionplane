CREATE SCHEMA "backoffice_auth";
--> statement-breakpoint
CREATE SCHEMA "tenant_auth";
--> statement-breakpoint
CREATE TABLE "backoffice_auth"."operator_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_auth"."catalog_organization_link" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_organization_id" text NOT NULL,
	"catalog_organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_profile_auth_user_id_unique" ON "backoffice_auth"."operator_profile" USING btree ("auth_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_organization_link_auth_id_unique" ON "tenant_auth"."catalog_organization_link" USING btree ("auth_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_organization_link_catalog_id_unique" ON "tenant_auth"."catalog_organization_link" USING btree ("catalog_organization_id");