app_name = "school_lms"
app_title = "School LMS"
app_publisher = "Ojzoor Private Limited"
app_description = "Online exam / LMS for the School ERP (proof of concept)"
app_email = "info@ojzoor.com"
app_license = "mit"

# Closes attempts whose time ran out (browser closed, network lost, etc.)
scheduler_events = {
	"cron": {
		"*/5 * * * *": [
			"school_lms.api.auto_close_expired",
		],
	},
}
