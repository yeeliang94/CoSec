-- MBRS AR1 annual return: share register entries, registered charges and annual return records.
CREATE TABLE `share_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `share_entries_company` ON `share_entries` (`company_id`,`status`);
--> statement-breakpoint
CREATE TABLE `charges` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `charges_company` ON `charges` (`company_id`);
--> statement-breakpoint
CREATE TABLE `annual_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`return_date` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `annual_returns_company_date` ON `annual_returns` (`company_id`,`return_date`);
--> statement-breakpoint
CREATE INDEX `annual_returns_status` ON `annual_returns` (`status`);
