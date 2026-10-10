app_name = "school_lms"
app_title = "School LMS"
app_publisher = "Ojzoor Private Limited"
app_description = "Online examination for the School Education System"
app_email = "info@ojzoor.com"
app_license = "mit"

# Uses Student, Class, Subject, Student Section, Academic Year, Exam Type and Topic from School Edtech.
required_apps = ["school_edtech"]

# Submits attempts whose time ran out (browser closed, network lost...) using their autosaved answers.
scheduler_events = {
	"cron": {
		"*/2 * * * *": [
			"school_lms.api.finalize_expired_attempts",
		],
	},
}
