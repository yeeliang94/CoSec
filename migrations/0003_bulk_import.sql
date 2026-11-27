-- Bulk import: one batch per client folder, one row per company folder inside it.
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `imports_creator` ON `imports` (`created_by`,`created_at`);
--> statement-breakpoint
CREATE TABLE `import_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`status` text NOT NULL,
	`claimed_by` text,
	`claimed_at` integer,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_companies_import` ON `import_companies` (`import_id`);
--> statement-breakpoint
CREATE INDEX `import_companies_status` ON `import_companies` (`status`,`claimed_at`);
