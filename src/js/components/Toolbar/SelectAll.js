import React from 'react'
import { inject, observer } from 'mobx-react'
import Checkbox from 'material-ui/Checkbox'
import Tooltip from 'material-ui/Tooltip'

@inject('searchStore')
@inject('tabStore')
@observer
export default class SelectAll extends React.Component {
  selectAll = (e) => {
    e.target.blur()
    const {
      searchStore: { allTabSelected, selectAll },
      tabStore: { unselectAll }
    } = this.props
    if (allTabSelected) {
      unselectAll()
    } else {
      selectAll()
    }
  }

  render () {
    const { allTabSelected } = this.props.searchStore
    const { selection } = this.props.tabStore
    const title = (allTabSelected ? 'Unselect' : 'Select') + ' all tabs'
    return (
      <Tooltip title={title}>
        <Checkbox
          checked={allTabSelected}
          onChange={this.selectAll}
          indeterminate={selection.size !== 0 && !allTabSelected}
        />
      </Tooltip>
    )
  }
}
