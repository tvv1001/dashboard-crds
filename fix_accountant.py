import re

with open('src/components/panel/StatusBox.tsx', 'r') as f:
    content = f.read()

old_skip = """	'registeredStates',
	'registrations',
	'currentConnections',
	'noticeFilings',"""

new_skip = """	'registeredStates',
	'registrations',
	'currentConnections',
	'noticeFilings',
	'accountantSurpriseExams',"""

content = content.replace(old_skip, new_skip)

old_sec_render = """					{hasGenuineSecContent && secBody?.noticeFilings && Array.isArray(secBody.noticeFilings) && secBody.noticeFilings.length > 0 && (
						<NoticeFilingsSection filings={secBody.noticeFilings} />
					)}
					{hasGenuineSecContent && (
						<RawFieldGroups
							title='Additional SEC details'
							body={secBody}
							source='sec'
						/>
					)}"""

new_sec_render = """					{hasGenuineSecContent && secBody?.noticeFilings && Array.isArray(secBody.noticeFilings) && secBody.noticeFilings.length > 0 && (
						<NoticeFilingsSection filings={secBody.noticeFilings} />
					)}
					{hasGenuineSecContent && secBody?.accountantSurpriseExams && Array.isArray(secBody.accountantSurpriseExams) && secBody.accountantSurpriseExams.length > 0 && (
						<AccountantSurpriseExamsSection exams={secBody.accountantSurpriseExams} />
					)}
					{hasGenuineSecContent && (
						<RawFieldGroups
							title='Additional SEC details'
							body={secBody}
							source='sec'
						/>
					)}"""

content = content.replace(old_sec_render, new_sec_render)

new_component = """function AccountantSurpriseExamsSection({ exams }: { exams: any[] }) {
	if (!exams || !exams.length) return null;
	return (
		<section className='record-detail-section record-detail-section--sec'>
			<h4 className='record-detail-section-title'>
				Accountant Surprise Exams ({exams.length})
				<span className='record-detail-inline-tag record-detail-inline-tag--sec'>SEC</span>
			</h4>
			<div className='disclosure-detail-list'>
				{exams.map((exam, index) => (
					<div
						className='disclosure-detail-card disclosure-card-item'
						key={`exam-${index}`}>
						<div className='disclosure-detail-card-header'>
							<span className='disclosure-detail-card-title'>{exam.accountantFirmName || 'Unknown Accountant Firm'}</span>
						</div>
						<div className='disclosure-detail-card-meta'>
							{exam.filingDate ? (
								<span>Filing Date: {exam.filingDate}</span>
							) : null}
							{exam.fileStatus ? (
								<span>File Status: {exam.fileStatus}</span>
							) : null}
							{exam.encryptedFilingID ? (
								<span>Encrypted ID: {exam.encryptedFilingID}</span>
							) : null}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function NoticeFilingsSection"""

content = content.replace("function NoticeFilingsSection", new_component)

with open('src/components/panel/StatusBox.tsx', 'w') as f:
    f.write(content)
