import re

with open('src/components/panel/StatusBox.tsx', 'r') as f:
    content = f.read()

old_skip = """	'registeredSROs',
	'registeredStates',
	'registrations',
	'currentConnections',"""

new_skip = """	'registeredSROs',
	'registeredStates',
	'registrations',
	'currentConnections',
	'noticeFilings',"""

content = content.replace(old_skip, new_skip)

old_sec_render = """					{hasGenuineSecContent && (
						<RawFieldGroups
							title='Additional SEC details'
							body={secBody}
							source='sec'
						/>
					)}"""

new_sec_render = """					{hasGenuineSecContent && secBody?.noticeFilings && Array.isArray(secBody.noticeFilings) && secBody.noticeFilings.length > 0 && (
						<NoticeFilingsSection filings={secBody.noticeFilings} />
					)}
					{hasGenuineSecContent && (
						<RawFieldGroups
							title='Additional SEC details'
							body={secBody}
							source='sec'
						/>
					)}"""

content = content.replace(old_sec_render, new_sec_render)

new_component = """function NoticeFilingsSection({ filings }: { filings: any[] }) {
	if (!filings || !filings.length) return null;
	return (
		<section className='record-detail-section record-detail-section--sec'>
			<h4 className='record-detail-section-title'>
				Notice Filings ({filings.length})
				<span className='record-detail-inline-tag record-detail-inline-tag--sec'>SEC</span>
			</h4>
			<div className='disclosure-detail-list'>
				{filings.map((filing, index) => (
					<div
						className='disclosure-detail-card disclosure-card-item'
						key={`notice-filing-${index}`}>
						<div className='disclosure-detail-card-header'>
							<span className='disclosure-detail-card-title'>{filing.jurisdiction || 'Unknown Jurisdiction'}</span>
						</div>
						<div className='disclosure-detail-card-meta'>
							{filing.status ? (
								<span>Status: {filing.status}</span>
							) : null}
							{filing.effectiveDate ? (
								<span>Effective: {filing.effectiveDate}</span>
							) : null}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

// covered by a curated section, so nothing in the raw FINRA/SEC JSON is"""

content = content.replace("// covered by a curated section, so nothing in the raw FINRA/SEC JSON is", new_component)

with open('src/components/panel/StatusBox.tsx', 'w') as f:
    f.write(content)
